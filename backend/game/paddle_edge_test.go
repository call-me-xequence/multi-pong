package game

import (
	"math"
	"testing"

	"neonpong/geometry"
)

// The paddle's block zone is widened by the ball radius at each tip so a ball
// that grazes the drawn edge (its disc still touching the paddle) bounces
// instead of counting as a goal. aimPaddleCross launches a ball that crosses
// the goal line of face 0 at a point `u` px from the face centre (positive =
// toward face end B) and reports whether player 0 conceded a goal.
func aimPaddleCross(t *testing.T, u float64) bool {
	t.Helper()
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	cfg.RespawnDelay = 100 // no respawn needed inside the probe loop

	// Face 0 geometry of a 2-player diamond (4 sides), same for every run.
	probe := NewRoom("edge-probe", cfg, 2)
	if _, err := probe.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := probe.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}
	if err := probe.Start("a"); err != nil {
		t.Fatal(err)
	}
	probe.mu.RLock()
	seg := probe.Walls[0]
	probe.mu.RUnlock()
	mid := geometry.Mul(geometry.Add(seg.A, seg.B), 0.5)
	ab := geometry.Sub(seg.B, seg.A)
	faceLen := math.Sqrt(geometry.Dot(ab, ab))
	tangent := geometry.Mul(ab, 1/faceLen)
	n := geometry.Norm(mid)

	r := NewRoom("edge-aim", cfg, 2)
	if _, err := r.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}
	if err := r.Start("a"); err != nil {
		t.Fatal(err)
	}

	cross := geometry.Add(mid, geometry.Mul(tangent, u))
	r.mu.Lock()
	b := r.Balls[0]
	b.X = cross.X - n.X*150
	b.Y = cross.Y - n.Y*150
	b.VX = n.X * cfg.BallSpeed
	b.VY = n.Y * cfg.BallSpeed
	r.mu.Unlock()

	lives := r.Players[0].Lives
	for i := 0; i < 90; i++ {
		r.Update(1.0 / float64(cfg.TickRate))
		if r.Players[0].Lives < lives {
			return true // goal conceded
		}
	}
	return false // blocked / bounced
}

func TestPaddleEdgeGraceBlocksGrazingBall(t *testing.T) {
	cfg := DefaultConfig()
	half := cfg.PaddleHalf()

	probe := NewRoom("edge-tip", cfg, 2)
	if _, err := probe.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := probe.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}
	if err := probe.Start("a"); err != nil {
		t.Fatal(err)
	}
	probe.mu.RLock()
	seg := probe.Walls[0]
	probe.mu.RUnlock()
	ab := geometry.Sub(seg.B, seg.A)
	faceLen := math.Sqrt(geometry.Dot(ab, ab))
	tipPx := half * faceLen // drawn paddle end, px from the face centre

	// Centre hit and a hit on the drawn tip itself must be blocked.
	if aimPaddleCross(t, 0) {
		t.Fatal("centre hit conceded a goal")
	}
	if aimPaddleCross(t, tipPx) {
		t.Fatal("hit exactly on the drawn paddle tip conceded a goal")
	}

	// A graze up to one ball radius beyond the drawn tip now bounces.
	if aimPaddleCross(t, tipPx+4) {
		t.Fatal("ball grazing 4px past the drawn tip should bounce (was goal)")
	}

	// A clearly outside shot still counts as a goal.
	if !aimPaddleCross(t, tipPx+16) {
		t.Fatal("ball 16px past the drawn tip should still be a goal")
	}
}
