package game

// Item / ability system. Items drop randomly during a match (when Config.Items
// is on), a player holds at most one, Space "arms" it, and — except for the
// Shield — the effect triggers the next time the ball hits that player's paddle.
// Everything here runs under Room.mu (the callers already hold the lock).

import (
	"math"
	"math/rand/v2"
	"time"

	"neonpong/geometry"
)

// Item ids (wire keys are the lower-case names).
const (
	ItemNone   = -1
	ItemFire   = 0
	ItemFlash  = 1
	ItemCurve  = 2
	ItemShield = 3
	ItemFreeze = 4
	ItemFake   = 5
	ItemSticky = 6
	ItemTether = 7
	ItemShake  = 8
)

const itemCount = 9

var itemKeys = [...]string{
	"fire", "flash", "curve", "shield", "freeze",
	"fake", "sticky", "tether", "shake",
}

// Item tuning.
const (
	itemDropMin     = 4.0 // seconds
	itemDropMax     = 7.0 // seconds
	fireWindow      = 3.0 // burning paddle window
	stickyArmWindow = 6.0 // sticky armed window
	shieldDuration  = 8.0 // impenetrable goal
	freezeDuration  = 3.0 // frozen opponent
	blindDuration   = 3.0 // flash blindness
	shakeDuration   = 6.0 // screen shake on others
	stickyStickTime = 0.6 // seconds a sticky ball sticks after a collision
	fireSpeedBoost  = 0.5 // +50%
	curveRate       = 3.5 // rad/s the curve ball bends
	curveLifeSec    = 3.0 // seconds a curve ball keeps bending
	tetherMaxHits   = 3   // opponent paddle bounces before the rope breaks
	tetherPaddleLen = 2.0 // rope length in paddle lengths
	iconHold        = 2.5 // seconds the "just used" icon stays behind the goal
)

func itemKey(id int) string {
	if id < 0 || id >= itemCount {
		return ""
	}
	return itemKeys[id]
}

func itemID(key string) int {
	for i, k := range itemKeys {
		if k == key {
			return i
		}
	}
	return ItemNone
}

// --- Drop --------------------------------------------------------------------

func (r *Room) scheduleNextItemLocked() {
	if !r.Config.Items {
		r.nextItemAt = time.Time{}
		return
	}
	delay := itemDropMin + rand.Float64()*(itemDropMax-itemDropMin)
	r.nextItemAt = time.Now().Add(time.Duration(delay * float64(time.Second)))
}

// grantRandomItemLocked gives a random item to a random alive player with an
// empty hand (no-op when nobody is eligible).
func (r *Room) grantRandomItemLocked() {
	var eligible []*Player
	for _, p := range r.Players {
		if p.IsAlive && p.Item == ItemNone {
			eligible = append(eligible, p)
		}
	}
	if len(eligible) == 0 {
		return
	}
	p := eligible[rand.IntN(len(eligible))]
	p.Item = rand.IntN(itemCount)
}

// dropTickLocked is called every tick while playing.
func (r *Room) dropTickLocked(now time.Time) {
	if r.Config.Items && !r.nextItemAt.IsZero() && now.After(r.nextItemAt) {
		r.grantRandomItemLocked()
		r.scheduleNextItemLocked()
	}
}

// UseItem consumes the held item and arms it (called from the WS handler).
func (r *Room) UseItem(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	var p *Player
	for _, x := range r.Players {
		if x.ID == id {
			p = x
			break
		}
	}
	if p == nil {
		return ErrPlayerNotFound
	}
	if p.Item == ItemNone {
		return ErrNoItem
	}
	if !p.IsAlive || r.State != StatePlaying {
		return ErrCannotUseItem
	}

	now := time.Now()
	held := p.Item
	p.Item = ItemNone
	switch held {
	case ItemFire:
		p.FireArmT = now.Add(time.Duration(fireWindow * float64(time.Second)))
	case ItemSticky:
		p.StickyArmT = now.Add(time.Duration(stickyArmWindow * float64(time.Second)))
	case ItemShield:
		p.ShieldT = now.Add(time.Duration(shieldDuration * float64(time.Second)))
	case ItemCurve:
		p.CurvedArm = true
	case ItemFlash:
		p.FlashArm = true
	case ItemFreeze:
		p.FreezeArm = true
	case ItemFake:
		p.FakeArm = true
	case ItemTether:
		p.TetherArm = true
	case ItemShake:
		p.ShakeArm = true
	}
	// Keep the icon visible for a short guaranteed window so everyone (and not
	// just the user) sees what was used even if the effect triggers instantly.
	p.IconKey = itemKey(held)
	p.IconUntil = now.Add(time.Duration(iconHold * float64(time.Second)))
	return nil
}

// resetItemsLocked clears every player's hand and effects, then schedules the
// first drop if items are enabled.
func (r *Room) resetItemsLocked() {
	r.nextItemAt = time.Time{}
	for _, p := range r.Players {
		p.Item = ItemNone
		p.FireArmT = time.Time{}
		p.StickyArmT = time.Time{}
		p.CurvedArm = false
		p.FlashArm = false
		p.FreezeArm = false
		p.FakeArm = false
		p.TetherArm = false
		p.ShakeArm = false
		p.IconKey = ""
		p.IconUntil = time.Time{}
		p.ShieldT = time.Time{}
		p.FrozenT = time.Time{}
		p.BlindT = time.Time{}
		p.ShakeT = time.Time{}
	}
	if r.Config.Items {
		r.scheduleNextItemLocked()
	}
}

// clearBallItemsLocked strips item effects from every ball (used on start).
func (r *Room) clearBallItemsLocked() {
	for _, b := range r.Balls {
		b.SpeedMul = 1
		b.OnFire = false
		b.Curve = 0
		b.Sticky = false
		b.StuckUntil = time.Time{}
		b.StuckToP = ""
		b.IsFake = false
		b.TetherOwner = ""
		b.TetherTarget = ""
		b.TetherHits = 0
	}
}

// --- Geometry helpers --------------------------------------------------------

// paddleCenterLocked returns the world position of a player's paddle centre.
func (r *Room) paddleCenterLocked(p *Player) geometry.Point {
	seg := r.Faces[p.Index]
	ab := geometry.Sub(seg.B, seg.A)
	return geometry.Add(seg.A, geometry.Mul(ab, p.Angle))
}

func (r *Room) aliveCountLocked() int {
	n := 0
	for _, p := range r.Players {
		if p.IsAlive {
			n++
		}
	}
	return n
}

// pointInZoneLocked reports whether (x,y) lies in player p's sector (from the
// arena centre). Each survivor owns an equal slice; with 2 players that is half
// the arena each.
func (r *Room) pointInZoneLocked(x, y float64, p *Player) bool {
	if p.Index < 0 {
		return false
	}
	alive := r.aliveCountLocked()
	if alive < 1 {
		return false
	}
	face := geometry.FaceMidAngle(r.Config.Sides, p.Index)
	d := math.Atan2(y, x) - face
	for d > math.Pi {
		d -= 2 * math.Pi
	}
	for d < -math.Pi {
		d += 2 * math.Pi
	}
	return math.Abs(d) <= math.Pi/float64(alive)
}

func (r *Room) anyBallInZoneLocked(p *Player) bool {
	for _, b := range r.Balls {
		if r.pointInZoneLocked(b.X, b.Y, p) {
			return true
		}
	}
	return false
}

// randomAliveOpponentLocked returns a random other alive player (excludes self).
func (r *Room) randomAliveOpponentLocked(self string) *Player {
	var others []*Player
	for _, p := range r.Players {
		if p.IsAlive && p.ID != self {
			others = append(others, p)
		}
	}
	if len(others) == 0 {
		return nil
	}
	return others[rand.IntN(len(others))]
}

// chooseTetherTargetLocked picks the alive opponent whose face the ball is most
// directly travelling toward (the receiver of a tethered shot).
func (r *Room) chooseTetherTargetLocked(self string, b *Ball) *Player {
	var best *Player
	bestDot := -2.0
	for _, p := range r.Players {
		if !p.IsAlive || p.ID == self || p.Index < 0 {
			continue
		}
		mid := geometry.FaceMidAngle(r.Config.Sides, p.Index)
		d := b.VX*math.Cos(mid) + b.VY*math.Sin(mid)
		if d > bestDot {
			bestDot = d
			best = p
		}
	}
	return best
}

// --- Per-tick updates --------------------------------------------------------

// tickItemTimersLocked expires armed windows and debuffs and reveals blinded
// players whose zone currently contains a ball.
func (r *Room) tickItemTimersLocked(now time.Time) {
	for _, p := range r.Players {
		if !p.FireArmT.IsZero() && now.After(p.FireArmT) {
			p.FireArmT = time.Time{}
		}
		if !p.StickyArmT.IsZero() && now.After(p.StickyArmT) {
			p.StickyArmT = time.Time{}
		}
		if !p.IconUntil.IsZero() && now.After(p.IconUntil) {
			p.IconKey = ""
			p.IconUntil = time.Time{}
		}
		if !p.ShieldT.IsZero() && now.After(p.ShieldT) {
			p.ShieldT = time.Time{}
		}
		if !p.FrozenT.IsZero() && now.After(p.FrozenT) {
			p.FrozenT = time.Time{}
		}
		if !p.ShakeT.IsZero() && now.After(p.ShakeT) {
			p.ShakeT = time.Time{}
		}
		if p.BlindT.After(now) {
			if r.anyBallInZoneLocked(p) {
				p.BlindT = time.Time{} // can see the ball coming
			}
		} else {
			p.BlindT = time.Time{}
		}
	}
}

func rotateVel(vx, vy, rad float64) (float64, float64) {
	c := math.Cos(rad)
	s := math.Sin(rad)
	return vx*c - vy*s, vx*s + vy*c
}

// applyCurveLocked bends a curve ball's direction by a fixed angular rate so the
// path is fully predictable from the ball's state (client mirrors this). The
// effect decays every tick so a curve ball always straightens out.
func (r *Room) applyCurveLocked(b *Ball, dt float64) {
	if b.Curve <= 0 || !b.StuckUntil.IsZero() {
		return
	}
	spd := math.Hypot(b.VX, b.VY)
	if spd == 0 {
		b.Curve = 0
		return
	}
	nx, ny := b.VX/spd, b.VY/spd
	rx, ry := rotateVel(nx, ny, curveRate*dt)
	b.VX = rx * spd
	b.VY = ry * spd
	b.Curve--
}

// tickTetherLocked snaps a tethered ball back to its anchor paddle when the
// rope goes taut (distance > rope length). Only active after the anchor's paddle
// has touched the ball at least once.
func (r *Room) tickTetherLocked(b *Ball) {
	if b.TetherOwner == "" || b.TetherTarget == "" || b.TetherHits < 1 || b.TetherHits >= tetherMaxHits {
		return
	}
	var anchor *Player
	for _, p := range r.Players {
		if p.ID == b.TetherTarget {
			anchor = p
			break
		}
	}
	if anchor == nil || !anchor.IsAlive || anchor.Index < 0 {
		// The rope's anchor is gone: break the tether.
		b.TetherOwner = ""
		b.TetherTarget = ""
		b.TetherHits = 0
		return
	}
	seg := r.Faces[anchor.Index]
	ropeLen := tetherPaddleLen * geometry.Len(geometry.Sub(seg.B, seg.A)) * r.Config.PaddleWidth
	ac := r.paddleCenterLocked(anchor)
	dx := b.X - ac.X
	dy := b.Y - ac.Y
	d := math.Hypot(dx, dy)
	if d <= ropeLen {
		return
	}
	nx, ny := -dx/d, -dy/d // unit vector back toward the anchor
	b.X = ac.X + nx*ropeLen*0.9
	b.Y = ac.Y + ny*ropeLen*0.9
	b.VX = nx * r.ballSpeed(b)
	b.VY = ny * r.ballSpeed(b)
}

// removeFakeOutsideZoneLocked deletes fake balls that left their owner's zone.
func (r *Room) removeFakeOutsideZoneLocked() {
	kept := r.Balls[:0]
	for _, b := range r.Balls {
		remove := false
		if b.IsFake {
			for _, p := range r.Players {
				if p.ID == b.FakeOwner {
					remove = !r.pointInZoneLocked(b.X, b.Y, p)
					break
				}
			}
		}
		if !remove {
			kept = append(kept, b)
		}
	}
	r.Balls = kept
	// If a removed fake was the only ball, make sure a replacement is scheduled so
	// the match never stalls with an empty arena.
	if r.State == StatePlaying && len(r.Balls) == 0 && r.nextBallAt.IsZero() {
		r.nextBallAt = time.Now()
	}
}

// --- Collision hooks ---------------------------------------------------------

// armedOneShotLocked returns the armed ability of p that must trigger on the
// next paddle contact, or ItemNone.
func armedOneShotLocked(p *Player) int {
	if !p.FireArmT.IsZero() {
		return ItemFire
	}
	if !p.StickyArmT.IsZero() {
		return ItemSticky
	}
	if p.CurvedArm {
		return ItemCurve
	}
	if p.FlashArm {
		return ItemFlash
	}
	if p.FreezeArm {
		return ItemFreeze
	}
	if p.FakeArm {
		return ItemFake
	}
	if p.TetherArm {
		return ItemTether
	}
	if p.ShakeArm {
		return ItemShake
	}
	return ItemNone
}

// triggerItemOnPaddleHitLocked applies the armed ability now that the ball has
// bounced off the using player's paddle (callers hold the write lock; b already
// has its post-bounce velocity).
func (r *Room) triggerItemOnPaddleHitLocked(b *Ball, p *Player) {
	// A tethered ball bounced by its anchor paddle counts a bounce.
	if b.TetherTarget == p.ID && !b.Sticky {
		b.TetherHits++
		if b.TetherHits >= tetherMaxHits {
			b.TetherOwner = ""
			b.TetherTarget = ""
		}
	}

	switch armedOneShotLocked(p) {
	case ItemFire:
		p.FireArmT = time.Time{}
		b.OnFire = true
		b.SpeedMul = 1 + fireSpeedBoost
		spd := math.Hypot(b.VX, b.VY)
		if spd > 0 {
			r.setBallSpeed(b, spd*(1+fireSpeedBoost))
		}
	case ItemSticky:
		p.StickyArmT = time.Time{}
		b.Sticky = true
	case ItemCurve:
		p.CurvedArm = false
		b.Curve = int(curveLifeSec * float64(r.Config.TickRate))
	case ItemFlash:
		p.FlashArm = false
		now := time.Now()
		for _, o := range r.Players {
			if o.ID != p.ID && o.IsAlive {
				o.BlindT = now.Add(time.Duration(blindDuration * float64(time.Second)))
			}
		}
	case ItemFreeze:
		p.FreezeArm = false
		if o := r.randomAliveOpponentLocked(p.ID); o != nil {
			o.FrozenT = time.Now().Add(time.Duration(freezeDuration * float64(time.Second)))
		}
	case ItemFake:
		p.FakeArm = false
		if len(r.Balls) < r.Config.MaxBalls {
			r.spawnFakeMirrorLocked(b, p)
		}
	case ItemTether:
		p.TetherArm = false
		target := r.chooseTetherTargetLocked(p.ID, b)
		if target != nil {
			b.TetherOwner = p.ID
			b.TetherTarget = target.ID
			b.TetherHits = 0
			ac := r.paddleCenterLocked(target)
			r.aimBallAtLocked(b, ac.X, ac.Y)
		}
	case ItemShake:
		p.ShakeArm = false
		now := time.Now()
		for _, o := range r.Players {
			if o.ID != p.ID && o.IsAlive {
				o.ShakeT = now.Add(time.Duration(shakeDuration * float64(time.Second)))
			}
		}
	}
}

// spawnFakeMirrorLocked creates a mirror "fake" ball (IsFake) that leaves the
// paddle at the mirrored direction of the real ball about the face normal, so
// the two balls leave like a "V".
func (r *Room) spawnFakeMirrorLocked(b *Ball, owner *Player) {
	spd := math.Hypot(b.VX, b.VY)
	if spd == 0 {
		spd = r.currentBallSpeed
	}
	n := geometry.Point{X: 0, Y: 1}
	if owner != nil && owner.Index >= 0 {
		seg := r.Faces[owner.Index]
		mid := geometry.Mul(geometry.Add(seg.A, seg.B), 0.5)
		n = geometry.Norm(mid)
	}
	vn := b.VX*n.X + b.VY*n.Y
	vfx := 2*vn*n.X - b.VX
	vfy := 2*vn*n.Y - b.VY
	f := &Ball{
		X:         b.X,
		Y:         b.Y,
		VX:        vfx,
		VY:        vfy,
		Radius:    b.Radius,
		SpeedMul:  speedMulForBall(b),
		OnFire:    b.OnFire,
		IsFake:    true,
		FakeOwner: owner.ID,
	}
	r.setBallSpeed(f, spd)
	r.Balls = append(r.Balls, f)
}

func (r *Room) aimBallAtLocked(b *Ball, tx, ty float64) {
	dx, dy := tx-b.X, ty-b.Y
	l := math.Hypot(dx, dy)
	if l == 0 {
		return
	}
	spd := math.Hypot(b.VX, b.VY)
	if spd == 0 {
		spd = r.ballSpeed(b)
	}
	b.VX = dx / l * spd
	b.VY = dy / l * spd
}

// playerByID returns the player with the given id, or nil.
func (r *Room) playerByID(id string) *Player {
	for _, p := range r.Players {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// ballSpeed returns the effective speed of a ball (fire balls are +50%).
func (r *Room) ballSpeed(b *Ball) float64 {
	spd := r.currentBallSpeed * speedMulForBall(b)
	if spd == 0 {
		spd = r.Config.BallSpeed
	}
	return spd
}

// stickToPaddleLocked pins a sticky ball to a player's paddle for a moment.
func (r *Room) stickToPaddleLocked(b *Ball, seg geometry.Segment, n geometry.Point, p *Player, t float64) {
	b.StuckUntil = time.Now().Add(time.Duration(stickyStickTime * float64(time.Second)))
	b.StuckToP = p.ID
	b.StuckT = t
	b.StuckNX = -n.X
	b.StuckNY = -n.Y
	pos := geometry.Add(seg.A, geometry.Mul(geometry.Sub(seg.B, seg.A), t))
	b.X = pos.X - n.X*b.Radius
	b.Y = pos.Y - n.Y*b.Radius
	b.VX, b.VY = 0, 0
}

// clearBallEffectsLocked strips item effects from a single ball.
func (r *Room) clearBallEffectsLocked(b *Ball) {
	b.SpeedMul = 1
	b.OnFire = false
	b.Curve = 0
	b.Sticky = false
	b.StuckUntil = time.Time{}
	b.StuckToP = ""
	b.IsFake = false
	b.TetherOwner = ""
	b.TetherTarget = ""
	b.TetherHits = 0
}

func (r *Room) setBallSpeed(b *Ball, spd float64) {
	cur := math.Hypot(b.VX, b.VY)
	if cur == 0 {
		b.VX = spd
		return
	}
	b.VX = b.VX / cur * spd
	b.VY = b.VY / cur * spd
}

// speedMulForBall returns the speed multiplier applied when normalizing a ball.
func speedMulForBall(b *Ball) float64 {
	if b.OnFire {
		if b.SpeedMul <= 0 {
			return 1 + fireSpeedBoost
		}
		return b.SpeedMul
	}
	return 1
}

// playerArmKey returns the wire key of the armed one-shot ability waiting for a
// paddle contact ("" = none). Timed arms (fire/sticky) are surfaced via fx.
func playerArmKey(p *Player) string {
	if p.CurvedArm {
		return "curve"
	}
	if p.FlashArm {
		return "flash"
	}
	if p.FreezeArm {
		return "freeze"
	}
	if p.FakeArm {
		return "fake"
	}
	if p.TetherArm {
		return "tether"
	}
	if p.ShakeArm {
		return "shake"
	}
	return ""
}

// playerUseKey returns the item key used a moment ago (during the short icon
// window), or "".
func playerUseKey(p *Player, now time.Time) string {
	if p.IconKey != "" && p.IconUntil.After(now) {
		return p.IconKey
	}
	return ""
}

// playerUseSec returns how many seconds the "just used" icon still has left.
func playerUseSec(p *Player, now time.Time) float64 {
	if p.IconKey == "" || !p.IconUntil.After(now) {
		return 0
	}
	return p.IconUntil.Sub(now).Seconds()
}

// frozenSpeedFactor returns the paddle speed factor for a player (freeze = 0.5).
func (r *Room) frozenSpeedFactor(p *Player) float64 {
	if !p.FrozenT.IsZero() && p.FrozenT.After(time.Now()) {
		return 0.5
	}
	return 1
}
