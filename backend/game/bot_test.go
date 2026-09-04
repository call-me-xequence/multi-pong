package game

// Tests for the bot (AI) players used in the private "vs bot" mode.

import (
	"math"
	"math/rand/v2"
	"testing"
	"time"

	"neonpong/geometry"
)

// newBotRoom builds a 2-player bot room (human + 1 bot) that is already playing.
// The bot keeps its huge "lives" value across many test shots.
func newBotRoom(t *testing.T, cfg *GameConfig) (*Room, *Player, *Player) {
	t.Helper()
	if cfg == nil {
		cfg = DefaultConfig()
		cfg.BallAccel = false
		cfg.AddBallInterval = 0
		cfg.Items = false
	}
	r := NewRoom("bot-room", cfg, 2)
	r.BotCount = 1
	if _, err := r.AddPlayer("human", "You"); err != nil {
		t.Fatalf("add human: %v", err)
	}
	var human, bot *Player
	r.mu.RLock()
	for _, p := range r.Players {
		if p.IsBot {
			bot = p
		} else {
			human = p
		}
	}
	r.mu.RUnlock()
	if human == nil || bot == nil {
		t.Fatal("expected one human and one bot after connect")
	}
	if err := r.Start("human"); err != nil {
		t.Fatalf("start: %v", err)
	}

	// Massive lives so the human never ends the match during a barrage.
	r.mu.Lock()
	for _, p := range r.Players {
		p.Lives = 1_000_000
	}
	// Park the human paddle at the very tip so it rarely interferes: balls the
	// bot deflects then score on the human quickly, ending each shot cleanly.
	human.Angle = cfg.PaddleHalf()
	human.InputDir = 0
	bot.Angle = 0.5
	bot.InputDir = 0
	r.mu.Unlock()
	return r, human, bot
}

// aimBallFromCenterLocked launches the first ball from the arena centre toward a
// random point across the bot's face.
func aimBallAtBotFace(r *Room, bot *Player, tMin, tMax float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Make sure exactly one ball exists and no pending respawn timer fires.
	r.nextBallAt = time.Time{}
	if len(r.Balls) == 0 {
		r.spawnBallLocked(bot.Index)
	} else if len(r.Balls) > 1 {
		r.Balls = r.Balls[:1]
	}
	b := r.Balls[0]
	seg := r.Faces[bot.Index]
	tt := tMin + rand.Float64()*(tMax-tMin)
	pt := geometry.Add(seg.A, geometry.Mul(geometry.Sub(seg.B, seg.A), tt))
	dist := math.Hypot(pt.X, pt.Y)
	spd := math.Hypot(b.VX, b.VY)
	if spd == 0 {
		spd = r.currentBallSpeed
	}
	b.X, b.Y = 0, 0
	b.VX = pt.X / dist * spd
	b.VY = pt.Y / dist * spd
	// Fresh ball: no lingering item effects from a previous shot.
	b.Curve = 0
	b.Sticky = false
	b.StuckUntil = time.Time{}
	b.IsFake = false
	b.TetherOwner = ""
	b.TetherTarget = ""
	b.TetherHits = 0
}

// TestBotBlocksAimedBarrage fires many shots across the bot's face and asserts
// the bot deflects the large majority of them (the "95%" feel of the mode).
func TestBotBlocksAimedBarrage(t *testing.T) {
	r, human, bot := newBotRoom(t, nil)
	_ = human
	dt := 1.0 / 60.0

	const shots = 60
	botMisses := 0
	emptyRun := 0
	ticks := 0
	for i := 0; i < shots; i++ {
		aimBallAtBotFace(r, bot, 0.15, 0.85)
		botLives := bot.Lives
		deadline := ticks + 60*8 // allow up to 8 sim-seconds per shot
		for ticks < deadline {
			r.Update(dt)
			ticks++
			r.mu.RLock()
			empty := len(r.Balls) == 0
			r.mu.RUnlock()
			if empty {
				break
			}
		}
		if bot.Lives < botLives {
			botMisses++
		}
		// Tidy up any ball still bouncing (rare endless-corner bounces).
		r.mu.Lock()
		if len(r.Balls) > 0 {
			if bot.Lives < botLives {
				emptyRun = 0
			} else {
				emptyRun++
			}
			r.Balls = r.Balls[:0]
			r.nextBallAt = time.Time{}
		}
		r.mu.Unlock()
	}

	rate := float64(shots-botMisses) / float64(shots)
	t.Logf("barrage: %d shots, %d got through (deflected %.1f%%)", shots, botMisses, rate*100)
	if botMisses > shots/10 {
		t.Fatalf("bot let too many shots through: %d/%d", botMisses, shots)
	}
}

// TestBotTracksAcrossWholeFace fires shots across the whole face including the
// edges (the hardest corners) and still expects a strong save rate.
func TestBotTracksAcrossWholeFace(t *testing.T) {
	r, _, bot := newBotRoom(t, nil)
	dt := 1.0 / 60.0
	const shots = 30
	misses := 0
	ticks := 0
	for i := 0; i < shots; i++ {
		aimBallAtBotFace(r, bot, 0.05, 0.95)
		before := bot.Lives
		deadline := ticks + 60*8
		for ticks < deadline {
			r.Update(dt)
			ticks++
			r.mu.RLock()
			empty := len(r.Balls) == 0
			r.mu.RUnlock()
			if empty {
				break
			}
		}
		if bot.Lives < before {
			misses++
		}
		r.mu.Lock()
		if len(r.Balls) > 0 {
			r.Balls = r.Balls[:0]
			r.nextBallAt = time.Time{}
		}
		r.mu.Unlock()
	}
	rate := float64(shots-misses) / float64(shots)
	t.Logf("full-face barrage: %d shots, %d got through (%.1f%%)", shots, misses, rate*100)
	if misses > shots/4 {
		t.Fatalf("bot weak at face edges: %d/%d missed", misses, shots)
	}
}

// TestBotUsesItemsImmediately verifies that bots take part in item drops and
// arm the ability the moment they receive it (never holding an item in hand).
func TestBotUsesItemsImmediately(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Items = true
	cfg.BallAccel = false
	cfg.AddBallInterval = 0
	r, human, bot := newBotRoom(t, cfg)
	_ = human

	// Many random drops: the bot must never keep an item in its slot.
	r.mu.Lock()
	botArmed := false
	for i := 0; i < 300; i++ {
		r.grantRandomItemLocked()
		if bot.Item != ItemNone {
			r.mu.Unlock()
			t.Fatalf("bot is holding item %d — bots must use items immediately", bot.Item)
		}
		if bot.FireArmT.After(time.Now()) || bot.StickyArmT.After(time.Now()) ||
			bot.CurvedArm || bot.FlashArm || bot.FreezeArm || bot.FakeArm ||
			bot.TetherArm || bot.ShakeArm || bot.ShieldT.After(time.Now()) {
			botArmed = true
		}
	}
	r.mu.Unlock()
	if !botArmed {
		t.Fatal("bot never armed an item across 300 drops")
	}

	// Direct grant + immediate arming consumes the item and activates the effect.
	r.mu.Lock()
	bot.Item = ItemShield
	r.armItemLocked(bot)
	held := bot.Item
	shieldUp := bot.ShieldT.After(time.Now())
	r.mu.Unlock()
	if held != ItemNone {
		t.Fatalf("armItemLocked did not consume the item (held=%d)", held)
	}
	if !shieldUp {
		t.Fatal("shield item was not activated on the bot")
	}
}

// TestBotNeverLosesToStaticHuman runs a real (unscripted) rally: the human never
// moves, so any ball reaching the human's open goal ends the rally — the bot
// must keep every ball from scoring on itself while the match runs.
func TestBotNeverLosesToStaticHuman(t *testing.T) {
	cfg := DefaultConfig()
	cfg.BallAccel = true
	cfg.AddBallInterval = 0
	cfg.Items = false
	r, human, bot := newBotRoom(t, cfg)
	dt := 1.0 / 60.0

	botStart := bot.Lives
	humanStart := human.Lives
	// 60 real seconds of unscripted play.
	for i := 0; i < 60*60; i++ {
		r.Update(dt)
		if r.State == StateEnded {
			break
		}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if bot.Lives < botStart {
		t.Fatalf("static human scored on the bot %d times in 60s", botStart-bot.Lives)
	}
	if human.Lives == humanStart {
		t.Log("note: ball stayed in play the whole minute (both faces defended)")
	}
}
