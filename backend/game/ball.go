package game

import "math"

// Ball is a moving projectile on the field.
type Ball struct {
	X, Y   float64
	VX, VY float64
	Radius float64
}

// Speed returns the current velocity magnitude.
func (b *Ball) Speed() float64 {
	return math.Hypot(b.VX, b.VY)
}
