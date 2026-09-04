package game

// Regression tests for the tether ("Связывание") item. The tethered ball must
// stay inside the arena, move without teleport-style jumps (which looked like it
// repeatedly flew out of the field and back through the paddle), and the rope
// must break after a few bounces off the anchor paddle.

import (
	"math"
	"testing"

	"neonpong/geometry"
)

// tetherRoom returns a 2-player room (host "a") in which player "a" has just
// fired the tether at player "b": the rope is anchored on B's paddle and the
// ball heads straight at B.
func tetherRoom(t *testing.T) *Room {
	t.Helper()
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	cfg.RespawnDelay = 100
	r := NewRoom("tether", cfg, 2)
	if _, err := r.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}
	if err := r.Start("a"); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	b := r.Balls[0]
	b.TetherOwner = "a"
	b.TetherTarget = "b"
	b.TetherHits = 0
	b.X, b.Y = 0, 0
	// B owns face 2 in the 2-player diamond; aim straight at B's paddle.
	angle := geometry.FaceMidAngle(4, 2)
	b.VX = 260 * math.Cos(angle)
	b.VY = 260 * math.Sin(angle)
	r.mu.Unlock()
	return r
}

// TestTetherStaysInsideNoTeleports: for the whole rally the tethered ball must
// never leave the arena and never take a teleport-scale step, and the rope must
// eventually break (after the anchor bounces it tetherMaxHits times) or score.
func TestTetherStaysInsideNoTeleports(t *testing.T) {
	r := tetherRoom(t)
	dt := 1.0 / 60.0

	lastX, lastY := 0.0, 0.0
	escaped := false
	for i := 0; i < 60*20; i++ {
		r.Update(dt)
		r.mu.RLock()
		if len(r.Balls) == 0 {
			r.mu.RUnlock() // the tethered shot scored — valid end of the rally
			return
		}
		b := r.Balls[0]
		if math.Hypot(b.X, b.Y) > r.Config.Radius+20 {
			escaped = true // outside the arena
		}
		if i > 0 {
			step := math.Hypot(b.X-lastX, b.Y-lastY)
			if step > 60 {
				escaped = true // teleport-scale jump in one tick
			}
		}
		lastX, lastY = b.X, b.Y
		r.mu.RUnlock()
		if escaped {
			t.Fatalf("tethered ball left the arena or teleported (i=%d)", i)
		}
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	b := r.Balls[0]
	if b.TetherTarget != "" || b.TetherHits != tetherMaxHits {
		t.Fatalf("rope did not break after %d anchor bounces (hits=%d, tethered=%v)",
			tetherMaxHits, b.TetherHits, b.TetherTarget != "")
	}
}

// TestTetherBallReturnsToAnchor: after the anchor bounces the ball away, the
// rope must pull it back so the anchor can hit it again (that is how the rope
// reaches its break point). We check that several distinct anchor contacts
// happen over the rally.
func TestTetherBallReturnsToAnchor(t *testing.T) {
	r := tetherRoom(t)
	dt := 1.0 / 60.0

	// Run until the rope breaks (3 anchor bounces) or the ball scores.
	for i := 0; i < 60*20; i++ {
		r.Update(dt)
		r.mu.RLock()
		if len(r.Balls) == 0 {
			r.mu.RUnlock()
			t.Fatalf("tethered ball scored on the anchor before the rope broke")
		}
		done := r.Balls[0].TetherTarget == ""
		hits := r.Balls[0].TetherHits
		r.mu.RUnlock()
		if done {
			if hits != tetherMaxHits {
				t.Fatalf("rope broke with %d anchor bounces (want %d)", hits, tetherMaxHits)
			}
			return
		}
	}
	t.Fatal("tether never reached its break point")
}
