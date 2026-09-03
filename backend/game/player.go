package game

import "time"

// queuedInput is a movement input waiting to be applied at a specific sim time.
type queuedInput struct {
	Dir int
	Seq uint32
	At  time.Time
}

// Player represents a single participant in a room.
type Player struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Index   int     `json:"index"` // face index, -1 until the game starts
	Angle   float64 `json:"angle"` // paddle position along the face, 0..1
	Lives   int     `json:"lives"`
	IsAlive bool    `json:"isAlive"`
	IsHost  bool    `json:"isHost"`

	// InputDir is the currently held movement direction: +1 right, -1 left, 0 idle.
	InputDir int

	// LastSeq is the sequence number of the last processed move input.
	LastSeq uint32

	// Queue holds inputs received out of order, applied when their sim time arrives.
	Queue []queuedInput

	// Held item (see items.go for ids). -1 = none; a player can hold only one.
	Item int

	// Armed one-shot buffs that trigger on the ball touching this player's paddle.
	FireArmT   time.Time // paddle burns (fire) - window 3s
	StickyArmT time.Time // sticky armed - window 6s
	CurvedArm  bool      // curve armed (until contact)
	FlashArm   bool      // blind/flash armed
	FreezeArm  bool      // freeze armed
	FakeArm    bool      // fake armed
	TetherArm  bool      // tether armed
	ShakeArm   bool      // shake armed

	// "Used just now" marker: the item icon stays behind the goal for a short
	// guaranteed window after pressing Space so everyone notices the activation.
	IconKey   string
	IconUntil time.Time

	// Passive / debuff states on this player.
	ShieldT time.Time // own goal impenetrable + aura
	FrozenT time.Time // paddle slowed 50% (ice)
	BlindT  time.Time // view blinded (flash)
	ShakeT  time.Time // screen shake (earthquake)

	// Send is the outbound queue consumed by the player's WebSocket writer goroutine.
	Send chan []byte

	// Kick is closed when the host kicks this player.
	Kick chan struct{}
}

// NewPlayer creates a player with a buffered send queue.
func NewPlayer(id, name string) *Player {
	return &Player{
		ID:      id,
		Name:    name,
		Index:   -1,
		Angle:   0.5,
		Lives:   0,
		IsAlive: true,
		Send:    make(chan []byte, 64),
		Kick:    make(chan struct{}),
	}
}
