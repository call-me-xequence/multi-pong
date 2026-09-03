package game

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
