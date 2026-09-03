package game

import "math"

// GameConfig holds all tunable parameters for a match.
type GameConfig struct {
	// Polygon
	Sides       int     // number of players / goal faces (set at game start)
	Radius      float64 // polygon circumradius
	Chamfer     float64 // corner cut radius
	PaddleWidth float64 // fraction of the face covered by the paddle (0..1)

	// Movement
	PaddleSpeed float64 // paddle speed along the face, units/second

	// Ball
	BallRadius   float64
	BallSpeed    float64 // initial ball speed (units/second)
	BallSpeedMax float64 // speed cap
	RespawnDelay float64 // seconds before the next ball spawns after a goal

	// Acceleration
	BallAccel     bool    // enable periodic acceleration
	AccelInterval float64 // seconds between accelerations
	AccelFactor   float64 // multiplier applied each interval (e.g. 1.05 = +5%)

	// Extra balls
	AddBallInterval float64 // seconds between new ball spawns (0 = disabled)
	MaxBalls        int

	// Lives
	Lives int

	// Items
	Items bool // whether power-up items drop during the match

	// Networking
	TickRate     int // server simulation rate (Hz)
	SnapshotRate int // snapshot broadcast rate (Hz)
}

// DefaultConfig returns sane defaults.
func DefaultConfig() *GameConfig {
	return &GameConfig{
		Sides:           6,
		Radius:          300,
		Chamfer:         40,
		PaddleWidth:     0.22,
		PaddleSpeed:     380,
		BallRadius:      9,
		BallSpeed:       260,
		BallSpeedMax:    700,
		RespawnDelay:    3,
		BallAccel:       true,
		AccelInterval:   10,
		AccelFactor:     1.05,
		AddBallInterval: 15,
		MaxBalls:        3,
		Lives:           3,
		TickRate:        60,
		SnapshotRate:    64,
	}
}

// FaceLength computes the length of a single face of the regular N-gon.
func (c *GameConfig) FaceLength() float64 {
	if c.Sides < 3 {
		return 0
	}
	return 2 * c.Radius * math.Sin(math.Pi/float64(c.Sides))
}

// PaddleHalf is the paddle half-width expressed as a fraction of the face (0..0.5).
func (c *GameConfig) PaddleHalf() float64 {
	w := c.PaddleWidth / 2
	if w > 0.49 {
		w = 0.49
	}
	if w < 0.01 {
		w = 0.01
	}
	return w
}
