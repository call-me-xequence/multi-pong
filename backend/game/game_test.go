package game

import (
	"math"
	"testing"
	"time"

	"neonpong/geometry"
)

func TestGeneratePolygonAndChamfer(t *testing.T) {
	for sides := 3; sides <= 8; sides++ {
		verts := geometry.GeneratePolygon(sides, 300)
		if len(verts) != sides {
			t.Fatalf("sides=%d: got %d vertices", sides, len(verts))
		}
		cham := geometry.ChamferVertices(verts, 40)
		if len(cham) != 2*sides {
			t.Fatalf("sides=%d: got %d chamfer points, want %d", sides, len(cham), 2*sides)
		}
		for _, p := range cham {
			if math.Hypot(p.X, p.Y) > 300.01 {
				t.Fatalf("chamfer point escaped radius: %+v", p)
			}
		}
	}
}

func TestSimulationRunsAndKeepsBallInside(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Sides = 4
	cfg.Radius = 300
	cfg.BallSpeed = 260
	cfg.AddBallInterval = 0 // keep a single ball for determinism

	r := NewRoom("test", cfg, 4)
	for i := 0; i < 4; i++ {
		if _, err := r.AddPlayer("p"+string(rune('a'+i)), "Player"); err != nil {
			t.Fatalf("add player %d: %v", i, err)
		}
	}
	if r.State != StatePlaying {
		t.Fatalf("expected playing, got %s", r.State)
	}

	dt := 1.0 / 60.0
	for i := 0; i < 60*60; i++ { // simulate 60 seconds
		r.Update(dt)

		r.mu.RLock()
		for _, b := range r.Balls {
			if math.Hypot(b.X, b.Y) > cfg.Radius*1.6+10 {
				r.mu.RUnlock()
				t.Fatalf("ball escaped arena: %+v", b)
			}
		}
		r.mu.RUnlock()
	}
}

func TestTwoPlayerSimulation(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0

	r := NewRoom("t2", cfg, 2)
	if _, err := r.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}
	if r.State != StatePlaying {
		t.Fatalf("expected playing, got %s", r.State)
	}
	if r.Config.Sides != 4 {
		t.Fatalf("expected 4-sided arena for 2 players, got %d", r.Config.Sides)
	}
	if r.Players[0].Index != 0 || r.Players[1].Index != 2 {
		t.Fatalf("unexpected player indices: %d, %d", r.Players[0].Index, r.Players[1].Index)
	}
	if r.faceOwner[0] != 0 || r.faceOwner[2] != 1 || r.faceOwner[1] != -1 || r.faceOwner[3] != -1 {
		t.Fatalf("bad face ownership: %v", r.faceOwner)
	}

	for i := 0; i < 60*30; i++ { // 30 seconds
		r.Update(1.0 / 60.0)
		r.mu.RLock()
		for _, b := range r.Balls {
			if math.Hypot(b.X, b.Y) > cfg.Radius*1.6+10 {
				r.mu.RUnlock()
				t.Fatalf("ball escaped: %+v", b)
			}
		}
		r.mu.RUnlock()
	}
}

func TestPaddleBouncesBall(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	r := NewRoom("pb", cfg, 4)
	for i := 0; i < 4; i++ {
		if _, err := r.AddPlayer("p"+string(rune('a'+i)), "P"); err != nil {
			t.Fatal(err)
		}
	}

	// Aim the ball exactly at the center of face 0 (where the paddle sits).
	b := r.Balls[0]
	b.X, b.Y = 0, 0
	angle := geometry.FaceMidAngle(4, 0)
	b.VX = 260 * math.Cos(angle)
	b.VY = 260 * math.Sin(angle)

	lives := r.Players[0].Lives
	for i := 0; i < 180; i++ { // 3 seconds — several full crossings
		r.Update(1.0 / 60.0)
	}
	if r.Players[0].Lives < lives {
		t.Fatalf("ball scored on a centered paddle (lives %d -> %d)", lives, r.Players[0].Lives)
	}
}

func TestPaddleInputClamps(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Sides = 3
	r := NewRoom("t", cfg, 3)
	for i := 0; i < 3; i++ {
		if _, err := r.AddPlayer("p"+string(rune('a'+i)), "P"); err != nil {
			t.Fatal(err)
		}
	}

	// Hold the paddle of player 0 "right" for a very long time.
	p := r.Players[0]
	for i := 0; i < 60*60; i++ {
		r.SetInput(p.ID, 1)
		r.Update(1.0 / 60.0)
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if p.Angle > 1-cfg.PaddleHalf() || p.Angle < cfg.PaddleHalf() {
		t.Fatalf("paddle angle out of bounds: %f", p.Angle)
	}
}

func TestGoalRemovesBallAndRespawnsAfterDelay(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	cfg.RespawnDelay = 3

	r := NewRoom("gr", cfg, 2)
	if _, err := r.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}

	// Park player A's paddle away from the face center so the ball scores.
	r.mu.Lock()
	r.Players[0].Angle = 0.15
	r.mu.Unlock()

	// Aim the ball exactly at the center of face 0.
	b := r.Balls[0]
	b.X, b.Y = 0, 0
	angle := geometry.FaceMidAngle(4, 0)
	b.VX = 260 * math.Cos(angle)
	b.VY = 260 * math.Sin(angle)

	startLives := r.Players[0].Lives
	for i := 0; i < 240 && r.Players[0].Lives == startLives; i++ {
		r.Update(1.0 / 60.0)
	}
	if r.Players[0].Lives == startLives {
		t.Fatal("ball never scored")
	}

	r.mu.RLock()
	n := len(r.Balls)
	pending := !r.nextBallAt.IsZero()
	r.mu.RUnlock()
	if n != 0 {
		t.Fatalf("expected 0 balls after goal, got %d", n)
	}
	if !pending {
		t.Fatal("expected a pending respawn after goal")
	}

	// Ticking forward in simulation time must NOT respawn the ball early.
	for i := 0; i < 60; i++ {
		r.Update(1.0 / 60.0)
	}
	r.mu.RLock()
	n = len(r.Balls)
	r.mu.RUnlock()
	if n != 0 {
		t.Fatalf("ball respawned before the 3s delay elapsed")
	}

	// Simulate the delay elapsing.
	r.mu.Lock()
	r.nextBallAt = time.Now().Add(-time.Second)
	r.mu.Unlock()
	r.Update(1.0 / 60.0)
	r.mu.RLock()
	n = len(r.Balls)
	r.mu.RUnlock()
	if n != 1 {
		t.Fatalf("expected 1 ball after the delay, got %d", n)
	}
}

func TestRestartAfterEndAllowsNewPlayers(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0

	r := NewRoom("rs", cfg, 3)
	if _, err := r.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}
	if err := r.Start("a"); err != nil {
		t.Fatalf("initial start: %v", err)
	}

	// Eliminate B -> one player remains -> match ends.
	r.mu.Lock()
	r.eliminateLocked("b")
	r.mu.Unlock()
	if r.State != StateEnded {
		t.Fatalf("expected ended, got %s", r.State)
	}

	// New player can join after the match ended.
	if _, err := r.AddPlayer("c", "C"); err != nil {
		t.Fatalf("join after end: %v", err)
	}
	if len(r.Players) != 3 {
		t.Fatalf("expected 3 players, got %d", len(r.Players))
	}

	// Host restarts with the full (new) roster.
	if err := r.Start("a"); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if r.State != StatePlaying {
		t.Fatalf("expected playing after restart, got %s", r.State)
	}
	for _, p := range r.Players {
		if !p.IsAlive || p.Lives != cfg.Lives {
			t.Fatalf("player %s not reset (alive=%v lives=%d)", p.ID, p.IsAlive, p.Lives)
		}
	}
}
