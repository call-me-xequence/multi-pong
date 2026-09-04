package game

import (
	"math"
	"time"
)

// Ball is a moving projectile on the field.
type Ball struct {
	X, Y   float64
	VX, VY float64
	Radius float64

	// Item extras (all guarded by Room.mu).
	SpeedMul float64 // speed multiplier, used when the ball is on fire (1.5)
	OnFire   bool    // fiery ball: flies 50% faster
	Curve    int     // >0 while the ball flies along an arc (decays every tick)
	Sticky   bool    // sticky ball: briefly sticks on any collision

	StickyUntil time.Time // when the Sticky effect wears off (zero = not sticky)

	StuckUntil time.Time // while set the ball is stuck (velocity zero)
	StuckToP   string    // player id the stuck ball follows ("" = fixed to a wall point)
	StuckT     float64   // offset from the paddle centre (in face units) if stuck to a paddle
	StuckNX    float64   // unit direction the ball had when it became stuck (for the delayed bounce)
	StuckNY    float64

	IsFake    bool   // mirror ball from the Fake ability
	FakeOwner string // player that spawned this fake ball

	TetherOwner  string // player that fired the tether ("" = none)
	TetherTarget string // opponent whose paddle the rope is tied to
	TetherHits   int    // times the ball has bounced off the target's paddle
}

// Speed returns the current velocity magnitude.
func (b *Ball) Speed() float64 {
	return math.Hypot(b.VX, b.VY)
}

// NewBall creates a ball with no item effects.
func NewBall(radius float64) *Ball {
	return &Ball{Radius: radius, SpeedMul: 1}
}
