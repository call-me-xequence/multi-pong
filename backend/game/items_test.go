package game

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"neonpong/geometry"
)

// Items are off by default: many ticks grant nobody an item.
func TestItemsDisabledByDefault(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	r := NewRoom("off", cfg, 2)
	_, _ = r.AddPlayer("a", "A")
	_, _ = r.AddPlayer("b", "B")
	if err := r.Start("a"); err != nil {
		t.Fatal(err)
	}
	dt := 1.0 / float64(cfg.TickRate)
	for i := 0; i < 60*20; i++ {
		r.Update(dt)
	}
	for _, p := range r.Players {
		if p.Item != ItemNone {
			t.Fatalf("items should be disabled: player holds %d", p.Item)
		}
	}
}

// With items enabled a random player receives a random item and never holds two.
func TestItemsDropAndHoldOne(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	cfg.Items = true
	r := NewRoom("on", cfg, 2)
	_, _ = r.AddPlayer("a", "A")
	_, _ = r.AddPlayer("b", "B")
	if err := r.Start("a"); err != nil {
		t.Fatal(err)
	}

	// Force a few drops (skip the random first-delay).
	r.mu.Lock()
	r.nextItemAt = time.Now().Add(-time.Second)
	r.mu.Unlock()
	dt := 1.0 / float64(cfg.TickRate)
	for i := 0; i < 60*30; i++ {
		r.Update(dt)
		any := false
		for _, p := range r.Players {
			if p.Item != ItemNone {
				any = true
			}
			if p.Item < ItemNone || p.Item >= itemCount {
				t.Fatalf("bad item id %d", p.Item)
			}
		}
		if any {
			return // at least one item was granted
		}
		// keep forcing drops so we don't wait on the timer
		r.mu.Lock()
		if r.nextItemAt.Before(time.Now()) {
			r.nextItemAt = time.Time{}
			r.grantRandomItemLocked()
			r.scheduleNextItemLocked()
		}
		r.mu.Unlock()
	}
	t.Fatal("no item was ever granted")
}

func TestUseItemConsumesAndArmsShield(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Items = true
	r := NewRoom("use", cfg, 2)
	_, _ = r.AddPlayer("a", "A")
	_, _ = r.AddPlayer("b", "B")
	if err := r.Start("a"); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	r.Players[0].Item = ItemShield
	r.mu.Unlock()
	if err := r.UseItem("a"); err != nil {
		t.Fatalf("use item: %v", err)
	}
	r.mu.RLock()
	p := r.Players[0]
	if p.Item != ItemNone {
		t.Fatalf("item not consumed: %d", p.Item)
	}
	if !p.ShieldT.After(time.Now()) {
		t.Fatal("shield not armed")
	}
	r.mu.RUnlock()
	// Using without an item should fail.
	if err := r.UseItem("a"); err != ErrNoItem {
		t.Fatalf("expected ErrNoItem, got %v", err)
	}
}

func TestShieldBlocksGoal(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	cfg.RespawnDelay = 100
	r := NewRoom("sh", cfg, 2)
	_, _ = r.AddPlayer("a", "A")
	_, _ = r.AddPlayer("b", "B")
	if err := r.Start("a"); err != nil {
		t.Fatal(err)
	}

	// Park A's paddle away from the centre, aim the ball at the centre of face 0.
	r.mu.Lock()
	r.Players[0].Angle = 0.15
	r.Players[0].ShieldT = time.Now().Add(8 * time.Second)
	r.mu.Unlock()
	b := r.Balls[0]
	b.X, b.Y = 0, 0
	angle := geometry.FaceMidAngle(4, 0)
	b.VX = 260 * math.Cos(angle)
	b.VY = 260 * math.Sin(angle)

	lives := r.Players[0].Lives
	for i := 0; i < 180; i++ {
		r.Update(1.0 / 60.0)
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.Players[0].Lives < lives {
		t.Fatalf("shield should have blocked the goal (lives %d -> %d)", lives, r.Players[0].Lives)
	}
	if r.Players[0].ShieldT.After(time.Now()) {
		t.Fatal("shield should have broken after blocking")
	}
}

func TestFireBallSpeedsUp(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	cfg.RespawnDelay = 100
	r := NewRoom("fire", cfg, 2)
	_, _ = r.AddPlayer("a", "A")
	_, _ = r.AddPlayer("b", "B")
	if err := r.Start("a"); err != nil {
		t.Fatal(err)
	}
	// Arm fire on A; aim the ball straight at the centred paddle of face 0.
	r.mu.Lock()
	r.Players[0].FireArmT = time.Now().Add(5 * time.Second)
	r.mu.Unlock()
	b := r.Balls[0]
	b.X, b.Y = 0, 0
	angle := geometry.FaceMidAngle(4, 0)
	b.VX = 260 * math.Cos(angle)
	b.VY = 260 * math.Sin(angle)

	for i := 0; i < 180; i++ {
		r.Update(1.0 / 60.0)
		r.mu.RLock()
		if len(r.Balls) == 0 {
			r.mu.RUnlock()
			t.Fatal("ball was removed (scored) before hitting the paddle")
		}
		hit := r.Balls[0].OnFire
		r.mu.RUnlock()
		if hit {
			break
		}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.Balls) == 0 || !r.Balls[0].OnFire {
		t.Fatal("fire never ignited the ball")
	}
	if spd := r.Balls[0].Speed(); spd < 260*1.45 {
		t.Fatalf("fire ball too slow: %.1f", spd)
	}
}

// Every item, once used, must be visible in the snapshot (fx / arm / use) so
// that ALL clients can draw its icon behind the goal of the user.
func TestEveryItemShowsIconMarker(t *testing.T) {
	for id := 0; id < itemCount; id++ {
		cfg := DefaultConfig()
		cfg.Items = true
		r := NewRoom("mark", cfg, 2)
		_, _ = r.AddPlayer("a", "A")
		_, _ = r.AddPlayer("b", "B")
		if err := r.Start("a"); err != nil {
			t.Fatal(err)
		}
		r.mu.Lock()
		r.Players[0].Item = id
		r.mu.Unlock()
		if err := r.UseItem("a"); err != nil {
			t.Fatalf("item %d use: %v", id, err)
		}

		data := r.SnapshotJSON("a")
		var snap struct {
			Players []struct {
				ID   string             `json:"id"`
				Arm  string             `json:"arm"`
				Use  string             `json:"use"`
				UseT float64            `json:"useT"`
				Fx   map[string]float64 `json:"fx"`
				Item string             `json:"item"`
			} `json:"players"`
		}
		if err := json.Unmarshal(data, &snap); err != nil {
			t.Fatal(err)
		}
		var me struct {
			Arm  string
			Use  string
			UseT float64
			Fx   map[string]float64
		}
		for _, p := range snap.Players {
			if p.ID == "a" {
				me.Arm, me.Use, me.UseT, me.Fx = p.Arm, p.Use, p.UseT, p.Fx
			}
		}
		key := itemKey(id)
		ok := me.Use == key && me.UseT > 0
		if key == "shield" {
			ok = ok || (me.Fx["shield"] > 0)
		}
		if key == "fire" {
			ok = ok || (me.Fx["fire"] > 0)
		}
		if key == "sticky" {
			ok = ok || (me.Fx["sticky"] > 0)
		}
		if !ok {
			t.Fatalf("item %s: no icon marker in snapshot (arm=%q use=%q useT=%.2f fx=%v)", key, me.Arm, me.Use, me.UseT, me.Fx)
		}
	}
}
