package game

// Regression tests for the sticky ("Липучка") item and the host "reset ball"
// action. Covers: sticky is temporary, a stuck ball rides with the paddle, a
// wall release keeps its tangential motion (no perpendicular wall-lock), and
// ResetBall respawns balls from the centre with effects cleared.

import (
	"math"
	"testing"
	"time"

	"neonpong/geometry"
)

// stickyRoom returns a 2-player room that is already playing (host "a").
func stickyRoom(t *testing.T) *Room {
	t.Helper()
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	cfg.RespawnDelay = 100
	r := NewRoom("sticky", cfg, 2)
	if _, err := r.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}
	if err := r.Start("a"); err != nil {
		t.Fatalf("start: %v", err)
	}
	return r
}

// aimAtPlayerCenter aims the first ball from the arena centre at player p's face.
func aimAtPlayerCenter(r *Room, p *Player) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b := r.Balls[0]
	b.X, b.Y = 0, 0
	angle := geometry.FaceMidAngle(4, p.Index)
	b.VX = 260 * math.Cos(angle)
	b.VY = 260 * math.Sin(angle)
}

// The sticky effect on a ball must end after its window (it must not stay
// sticky for the rest of the rally).
func TestStickyBallEffectEnds(t *testing.T) {
	r := stickyRoom(t)
	r.mu.Lock()
	r.Players[0].StickyArmT = time.Now().Add(5 * time.Second)
	r.mu.Unlock()
	aimAtPlayerCenter(r, r.Players[0])

	dt := 1.0 / 60.0
	stuck := false
	for i := 0; i < 240; i++ {
		r.Update(dt)
		r.mu.RLock()
		if len(r.Balls) == 0 {
			r.mu.RUnlock()
			t.Fatal("ball scored before the sticky arming contact")
		}
		b := r.Balls[0]
		if b.Sticky && !b.StuckUntil.IsZero() && b.StickyUntil.After(time.Now()) {
			stuck = true
		}
		r.mu.RUnlock()
		if stuck {
			break
		}
	}
	if !stuck {
		t.Fatal("ball never became sticky on the arming contact")
	}

	// Expire the sticky window: the effect must clear on the next tick.
	r.mu.Lock()
	r.Balls[0].StickyUntil = time.Now().Add(-time.Second)
	r.mu.Unlock()
	for i := 0; i < 60; i++ {
		r.Update(dt)
		r.mu.RLock()
		gone := len(r.Balls) == 0 || !r.Balls[0].Sticky
		r.mu.RUnlock()
		if gone {
			return
		}
	}
	t.Fatal("sticky effect never expired")
}

// A ball stuck to a paddle must ride along as the paddle moves.
func TestStuckBallFollowsPaddle(t *testing.T) {
	r := stickyRoom(t)
	dt := 1.0 / 60.0
	p := r.Players[0]

	r.mu.Lock()
	p.Angle = 0.5
	r.Players[1].Angle = 0.5
	seg := r.Faces[p.Index]
	n := geometry.Norm(geometry.Mul(geometry.Add(seg.A, seg.B), 0.5))
	// Stick the ball dead-centre of p's paddle (offset 0).
	r.stickToPaddleLocked(r.Balls[0], seg, n, p, 0.5)
	r.mu.Unlock()

	// Hold the paddle right for ~0.3s (within the 0.6s stick window).
	for i := 0; i < 18; i++ {
		r.SetInput(p.ID, 1, uint32(i+1))
		r.Update(dt)
	}
	r.SetInput(p.ID, 0, 1000)

	r.mu.RLock()
	defer r.mu.RUnlock()
	b := r.Balls[0]
	if b.StuckToP != p.ID {
		t.Fatal("ball is no longer stuck to the paddle")
	}
	ab := geometry.Sub(seg.B, seg.A)
	rel := geometry.Sub(geometry.Point{X: b.X, Y: b.Y}, seg.A)
	coord := geometry.Dot(rel, ab) / geometry.Dot(ab, ab)
	if math.Abs(coord-p.Angle) > 0.02 {
		t.Fatalf("ball did not follow the paddle: coord=%.3f paddle=%.3f", coord, p.Angle)
	}
}

// When a sticky ball releases from a wall it must keep its tangential motion.
// Otherwise it can end up bouncing straight back and forth between two parallel
// (unowned) walls, out of everyone's reach.
func TestStickyWallReleaseKeepsAngle(t *testing.T) {
	r := stickyRoom(t)

	r.mu.Lock()
	// Find an unowned goal face (a plain wall) of the 2-player diamond.
	faceIdx := -1
	for i, owner := range r.faceOwner {
		if owner < 0 {
			faceIdx = i
			break
		}
	}
	if faceIdx < 0 {
		r.mu.Unlock()
		t.Fatal("no unowned wall face in a 2-player room")
	}
	seg := r.Faces[faceIdx]
	mid := geometry.Mul(geometry.Add(seg.A, seg.B), 0.5)
	n := geometry.Norm(mid) // outward normal
	if geometry.Len(n) == 0 {
		r.mu.Unlock()
		t.Fatal("bad wall normal")
	}
	tang := geometry.Perp(n) // tangent along the wall
	b := r.Balls[0]

	// Rest the ball just inside the wall (slightly closer than one radius so the
	// release helper can detect the wall).
	b.X = mid.X - n.X*(b.Radius-0.5)
	b.Y = mid.Y - n.Y*(b.Radius-0.5)
	// Incoming direction: into the wall with a healthy tangential component.
	dx := n.X*0.6 + tang.X*0.8
	dy := n.Y*0.6 + tang.Y*0.8
	l := math.Hypot(dx, dy)
	dx, dy = dx/l, dy/l
	b.StuckNX, b.StuckNY = dx, dy
	b.StuckToP = ""
	b.StuckT = 0
	b.StuckUntil = time.Now().Add(-time.Millisecond) // expired: release next tick
	b.VX, b.VY = 0, 0
	b.Sticky = false
	r.mu.Unlock()

	r.Update(1.0 / 60.0) // triggers the release

	r.mu.RLock()
	defer r.mu.RUnlock()
	spd := math.Hypot(b.VX, b.VY)
	tv := (b.VX*tang.X + b.VY*tang.Y) / spd // tangential component (unit)
	if tv < 0.2 {
		t.Fatalf("wall release lost tangential motion (relT=%.2f) — ball could get trapped", tv)
	}
}

// ResetBall must be host-only, end the rally like a goal (balls removed, item
// effects stripped) and schedule a fresh serve after the respawn delay.
func TestResetBall(t *testing.T) {
	r := stickyRoom(t)

	r.mu.Lock()
	b := r.Balls[0]
	b.Sticky = true
	b.StickyUntil = time.Now().Add(10 * time.Second)
	b.OnFire = true
	b.SpeedMul = 1.5
	b.X, b.Y = 100, 100
	b.VX, b.VY = 300, -200
	r.mu.Unlock()

	if err := r.ResetBall("b"); err == nil {
		t.Fatal("non-host reset accepted")
	}
	if err := r.ResetBall("a"); err != nil {
		t.Fatalf("host reset failed: %v", err)
	}

	r.mu.RLock()
	empty := len(r.Balls) == 0
	pending := !r.nextBallAt.IsZero()
	r.mu.RUnlock()
	if !empty {
		t.Fatal("reset must clear every ball from the arena")
	}
	if !pending {
		t.Fatal("reset must schedule a fresh serve after the respawn delay")
	}

	// When the serve time arrives the game throws a fresh ball.
	r.mu.Lock()
	r.nextBallAt = time.Now().Add(-time.Millisecond)
	r.mu.Unlock()
	r.Update(1.0 / 60.0)
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.Balls) == 0 {
		t.Fatal("no ball served after the reset delay")
	}
	if r.Balls[0].Sticky || r.Balls[0].OnFire {
		t.Fatal("served ball kept item effects")
	}
}
