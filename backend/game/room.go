package game

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"sync"
	"time"

	"neonpong/geometry"
)

// Room state values.
const (
	StateWaiting = "waiting"
	StatePlaying = "playing"
	StateEnded   = "ended"
)

// Room is a single match instance shared between several clients.
type Room struct {
	mu         sync.RWMutex
	ID         string
	MaxPlayers int
	Config     *GameConfig
	Players    []*Player
	Balls      []*Ball
	State      string
	HostID     string
	WinnerID   string
	CreatedAt  time.Time

	// Geometry (built at Start).
	Walls     []geometry.Segment // 2*N segments: even = face, odd = chamfer
	Faces     []geometry.Segment // N faces, index = player index
	faceOwner []int              // faceOwner[face] = index into Players, or -1

	// Runtime.
	currentBallSpeed float64
	startedAt        time.Time
	lastAccelAt      time.Time
	lastAddBallAt    time.Time
	nextBallAt       time.Time // when the next ball spawns after a goal (zero = none pending)

	done   chan struct{}
	onDone func()
}

// NewRoom creates a room with the given config and capacity.
func NewRoom(id string, cfg *GameConfig, maxPlayers int) *Room {
	r := &Room{
		ID:         id,
		MaxPlayers: maxPlayers,
		Config:     cfg,
		Players:    make([]*Player, 0, maxPlayers),
		Balls:      make([]*Ball, 0, cfg.MaxBalls),
		State:      StateWaiting,
		CreatedAt:  time.Now(),
		done:       make(chan struct{}),
	}
	return r
}

// SetDoneCallback registers a callback invoked when the room loop exits.
func (r *Room) SetDoneCallback(fn func()) {
	r.onDone = fn
}

// Stop asks the room loop to terminate.
func (r *Room) Stop() {
	select {
	case <-r.done:
	default:
		close(r.done)
	}
}

// Done returns a channel closed when the room stops.
func (r *Room) Done() <-chan struct{} { return r.done }

// Info returns a small read-only description for the REST room list.
func (r *Room) Info() (id string, players, maxPlayers int, state string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.ID, len(r.Players), r.MaxPlayers, r.State
}

// AddPlayer adds a new player. Joining is allowed while waiting or after the
// match has ended (so new players can join before a rematch).
func (r *Room) AddPlayer(id, name string) (*Player, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.State != StateWaiting && r.State != StateEnded {
		return nil, ErrGameStarted
	}
	if len(r.Players) >= r.MaxPlayers {
		return nil, ErrRoomFull
	}
	for _, p := range r.Players {
		if p.ID == id {
			return nil, ErrDuplicatePlayer
		}
	}
	p := NewPlayer(id, name)
	if len(r.Players) == 0 {
		p.IsHost = true
		r.HostID = id
	}
	wasWaiting := r.State == StateWaiting
	r.Players = append(r.Players, p)

	// Auto-start only when filling up from the waiting state. After a match has
	// ended, the host explicitly starts a rematch instead.
	if wasWaiting && len(r.Players) >= r.MaxPlayers {
		r.startLocked()
	}
	return p, nil
}

// RemovePlayer removes a player (disconnect). If the host leaves, host is transferred.
func (r *Room) RemovePlayer(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	idx := -1
	for i, p := range r.Players {
		if p.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return
	}
	r.Players = append(r.Players[:idx], r.Players[idx+1:]...)

	// Waiting or ended: remove cleanly and transfer the host if needed.
	if r.State != StatePlaying {
		if len(r.Players) == 0 {
			r.HostID = ""
			return
		}
		if r.HostID == id {
			r.Players[0].IsHost = true
			r.HostID = r.Players[0].ID
		}
		return
	}

	// In-game disconnect: eliminate the player.
	r.eliminateLocked(id)
}

// SetInput records the currently held movement direction for a player. seq is
// the client's input sequence number, echoed back in snapshots so the client
// can reconcile its local prediction.
func (r *Room) SetInput(id string, dir int, seq uint32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.Players {
		if p.ID == id {
			// Ignore stale or duplicate inputs.
			if seq < p.LastSeq {
				return
			}
			if dir > 1 {
				dir = 1
			}
			if dir < -1 {
				dir = -1
			}
			p.InputDir = dir
			p.LastSeq = seq
			return
		}
	}
}

// Start begins the match (host only, at least two players). It also serves as
// "rematch": after the match ends, the host can start a new one with whoever
// is currently in the room.
func (r *Room) Start(hostID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.HostID != hostID {
		return ErrNotHost
	}
	if r.State != StateWaiting && r.State != StateEnded {
		return ErrGameStarted
	}
	if len(r.Players) < 2 {
		return ErrNotEnoughPlayers
	}
	r.startLocked()
	return nil
}

// startLocked performs the actual start (caller must hold the write lock).
func (r *Room) startLocked() {
	cfg := r.Config
	n := len(r.Players)

	// A regular polygon needs >= 3 sides, so a 2-player match uses a 4-sided
	// arena (a diamond) where two opposite faces are goals and the other two
	// are plain walls.
	arenaSides := n
	if arenaSides == 2 {
		arenaSides = 4
	}
	cfg.Sides = arenaSides

	for i, p := range r.Players {
		p.Angle = 0.5
		p.Lives = cfg.Lives
		p.IsAlive = true
		if n == 2 {
			p.Index = 2 * i // 0 and 2 (opposite faces)
		} else {
			p.Index = i
		}
	}

	r.faceOwner = make([]int, arenaSides)
	for i := range r.faceOwner {
		r.faceOwner[i] = -1
	}
	for i, p := range r.Players {
		r.faceOwner[p.Index] = i
	}

	r.buildGeometryLocked()
	r.currentBallSpeed = cfg.BallSpeed
	r.Balls = r.Balls[:0]
	r.spawnBallLocked(0)

	now := time.Now()
	r.startedAt = now
	r.lastAccelAt = now
	r.lastAddBallAt = now
	r.nextBallAt = time.Time{}
	r.State = StatePlaying
}

// buildGeometryLocked builds the chamfered polygon walls and face list.
func (r *Room) buildGeometryLocked() {
	cfg := r.Config
	n := cfg.Sides
	vertices := geometry.GeneratePolygon(n, cfg.Radius)
	chamfered := geometry.ChamferVertices(vertices, cfg.Chamfer)

	r.Walls = make([]geometry.Segment, 0, 2*n)
	for i := 0; i < len(chamfered); i++ {
		a := chamfered[i]
		b := chamfered[(i+1)%len(chamfered)]
		r.Walls = append(r.Walls, geometry.Segment{A: a, B: b})
	}
	r.Faces = make([]geometry.Segment, 0, n)
	for i := 0; i < n; i++ {
		r.Faces = append(r.Faces, r.Walls[2*i])
	}
}

// respawnBallLocked places the ball at the center with a random direction.
// If targetFace >= 0 the ball is aimed at that face's midpoint.
func (r *Room) respawnBallLocked(b *Ball, targetFace int) {
	cfg := r.Config
	b.X, b.Y = 0, 0

	angle := rand.Float64() * 2 * 3.141592653589793
	if targetFace >= 0 {
		angle = geometry.FaceMidAngle(cfg.Sides, targetFace)
	}
	// small random spread
	angle += (rand.Float64()*2 - 1) * 0.35

	b.VX = r.currentBallSpeed * math.Cos(angle)
	b.VY = r.currentBallSpeed * math.Sin(angle)
}

// spawnBallLocked creates and adds a ball, aiming it at targetFace (-1 = random).
func (r *Room) spawnBallLocked(targetFace int) {
	b := &Ball{Radius: r.Config.BallRadius}
	r.respawnBallLocked(b, targetFace)
	r.Balls = append(r.Balls, b)
}

// randomAliveFaceLocked returns the face index of a random surviving player, or -1.
func (r *Room) randomAliveFaceLocked() int {
	alive := make([]int, 0, len(r.Players))
	for _, p := range r.Players {
		if p.IsAlive {
			alive = append(alive, p.Index)
		}
	}
	if len(alive) == 0 {
		return -1
	}
	return alive[rand.IntN(len(alive))]
}

// removeBallLocked removes a ball from the active list.
func (r *Room) removeBallLocked(b *Ball) {
	for i, x := range r.Balls {
		if x == b {
			r.Balls = append(r.Balls[:i], r.Balls[i+1:]...)
			return
		}
	}
}

// respawnInLocked returns seconds until the next ball spawns (0 if none pending).
func (r *Room) respawnInLocked(now time.Time) float64 {
	if r.nextBallAt.IsZero() || !now.Before(r.nextBallAt) {
		return 0
	}
	return r.nextBallAt.Sub(now).Seconds()
}

// RunLoop is the room's simulation + broadcast loop. Runs in its own goroutine.
func (r *Room) RunLoop() {
	cfg := r.Config
	tickRate := cfg.TickRate
	if tickRate <= 0 {
		tickRate = 60
	}
	ticker := time.NewTicker(time.Second / time.Duration(tickRate))
	defer ticker.Stop()
	defer func() {
		if r.onDone != nil {
			r.onDone()
		}
	}()

	// Broadcast snapshots at the configured rate (independent of the tick rate).
	snapRate := cfg.SnapshotRate
	if snapRate <= 0 {
		snapRate = 20
	}
	snapInterval := time.Duration(float64(time.Second) / float64(snapRate))
	nextBroadcast := time.Now().Add(snapInterval)
	dt := 1.0 / float64(tickRate)

	for {
		select {
		case <-r.done:
			return
		case <-ticker.C:
			r.Update(dt)
			if time.Now().After(nextBroadcast) {
				r.Broadcast()
				nextBroadcast = nextBroadcast.Add(snapInterval)
				if nextBroadcast.Before(time.Now()) {
					nextBroadcast = time.Now().Add(snapInterval)
				}
			}
		}
	}
}

// --- Snapshot / broadcast ---------------------------------------------------

type snapshotBall struct {
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	VX float64 `json:"vx"`
	VY float64 `json:"vy"`
}

type snapshotPlayer struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Index   int     `json:"index"`
	Angle   float64 `json:"angle"`
	Lives   int     `json:"lives"`
	IsAlive bool    `json:"isAlive"`
	IsHost  bool    `json:"isHost"`
	LastSeq uint32  `json:"lastSeq"`
}

type snapshot struct {
	Type        string           `json:"type"`
	T           int64            `json:"t"`
	RoomID      string           `json:"roomID"`
	You         string           `json:"you,omitempty"`
	State       string           `json:"state"`
	Host        string           `json:"host"`
	Winner      string           `json:"winner,omitempty"`
	Sides       int              `json:"sides"`
	Radius      float64          `json:"radius"`
	Chamfer     float64          `json:"chamfer"`
	PaddleHalf  float64          `json:"paddleHalf"`
	PaddleSpeed float64          `json:"paddleSpeed"`
	BallRadius  float64          `json:"ballRadius"`
	BallSpeed   float64          `json:"ballSpeed"`
	RespawnIn   float64          `json:"respawnIn"`
	Players     []snapshotPlayer `json:"players"`
	Balls       []snapshotBall   `json:"balls"`
}

// SnapshotJSON builds the current world snapshot as JSON bytes for one viewer.
func (r *Room) SnapshotJSON(youID string) []byte {
	r.mu.RLock()
	defer r.mu.RUnlock()

	now := time.Now()
	s := snapshot{
		Type:        "snapshot",
		T:           now.UnixMilli(),
		RoomID:      r.ID,
		You:         youID,
		State:       r.State,
		Host:        r.HostID,
		Sides:       r.Config.Sides,
		Radius:      r.Config.Radius,
		Chamfer:     r.Config.Chamfer,
		PaddleHalf:  r.Config.PaddleHalf(),
		PaddleSpeed: r.Config.PaddleSpeed,
		BallRadius:  r.Config.BallRadius,
		BallSpeed:   r.currentBallSpeed,
		RespawnIn:   r.respawnInLocked(now),
		Players:     make([]snapshotPlayer, 0, len(r.Players)),
		Balls:       make([]snapshotBall, 0, len(r.Balls)),
	}
	if r.State == StateEnded {
		s.Winner = r.WinnerID
	}
	for _, p := range r.Players {
		s.Players = append(s.Players, snapshotPlayer{
			ID: p.ID, Name: p.Name, Index: p.Index,
			Angle: p.Angle, Lives: p.Lives,
			IsAlive: p.IsAlive, IsHost: p.IsHost,
			LastSeq: p.LastSeq,
		})
	}
	for _, b := range r.Balls {
		s.Balls = append(s.Balls, snapshotBall{X: b.X, Y: b.Y, VX: b.VX, VY: b.VY})
	}

	data, err := json.Marshal(s)
	if err != nil {
		return []byte(`{"type":"error","message":"marshal"}`)
	}
	return data
}

// Broadcast sends the current snapshot to every connected player.
func (r *Room) Broadcast() {
	r.mu.RLock()
	players := make([]*Player, len(r.Players))
	copy(players, r.Players)
	r.mu.RUnlock()

	for _, p := range players {
		data := r.SnapshotJSON(p.ID)
		select {
		case p.Send <- data:
		default: // slow client: drop this snapshot
		}
	}
}

// AliveCount returns how many players are still alive.
func (r *Room) AliveCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	n := 0
	for _, p := range r.Players {
		if p.IsAlive {
			n++
		}
	}
	return n
}

// MatchDuration returns elapsed match time.
func (r *Room) MatchDuration() time.Duration {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.State == StateWaiting {
		return 0
	}
	return time.Since(r.startedAt)
}
