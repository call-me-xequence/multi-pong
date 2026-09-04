package game

// Regression: after a rematch the server must not keep moving a player's paddle
// with an input that was held at the end of the previous match.

import "testing"

func TestRestartClearsHeldInput(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AddBallInterval = 0
	r := NewRoom("restart-input", cfg, 2)
	if _, err := r.AddPlayer("a", "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddPlayer("b", "B"); err != nil {
		t.Fatal(err)
	}
	if err := r.Start("a"); err != nil {
		t.Fatalf("start: %v", err)
	}

	// Player A holds "right" and the paddle starts moving.
	dt := 1.0 / 60.0
	for i := 0; i < 5; i++ {
		r.SetInput("a", 1, uint32(i+1))
		r.Update(dt)
	}
	r.mu.RLock()
	heldBefore := r.Players[0].InputDir
	movedBefore := r.Players[0].Angle != 0.5
	r.mu.RUnlock()
	if heldBefore != 1 || !movedBefore {
		t.Fatalf("setup failed: InputDir=%d moved=%v", heldBefore, movedBefore)
	}

	// Force the match to end (B eliminated), then start a rematch.
	r.mu.Lock()
	r.Players[1].Lives = 0
	r.Players[1].IsAlive = false
	r.checkEndLocked()
	r.mu.Unlock()
	if r.State != StateEnded {
		t.Fatalf("expected ended, got %s", r.State)
	}
	if err := r.Start("a"); err != nil {
		t.Fatalf("rematch: %v", err)
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.Players[0].InputDir != 0 {
		t.Fatalf("held input survived the restart (InputDir=%d)", r.Players[0].InputDir)
	}
}
