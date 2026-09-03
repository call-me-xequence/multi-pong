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

// Lag compensation tuning.
const (
	maxHistory     = 20    // ~333 ms of rewound state at 60 Hz
	maxRewindTicks = 15    // ~250 ms
	maxRewindMs    = 250.0 // clamp the client-reported lag
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
	Password   string
	CreatedAt  time.Time

	// Geometry (built at Start).
	Walls     []geometry.Segment // 2*N segments: even = face, odd = chamfer
	Faces     []geometry.Segment // N faces, index = player index
	faceOwner []int              // faceOwner[face] = index into Players, or -1

	// Runtime.
	simTime          time.Time
	currentBallSpeed float64
	startedAt        time.Time
	lastAccelAt      time.Time
	lastAddBallAt    time.Time
	nextBallAt       time.Time // when the next ball spawns after a goal (zero = none pending)
	nextItemAt       time.Time // when the next item drops (zero = items disabled/stopped)
	history          []historyEntry

	done   chan struct{}
	onDone func()
}

// ballState and playerState capture the parts of the world needed to rewind.
type ballState struct {
	X, Y, VX, VY float64
	// Item state (must survive a rewind so effects aren't lost).
	SpeedMul     float64
	OnFire       bool
	Curve        int
	Sticky       bool
	StuckUntil   time.Time
	StuckToP     string
	StuckT       float64
	StuckNX      float64
	StuckNY      float64
	IsFake       bool
	FakeOwner    string
	TetherOwner  string
	TetherTarget string
	TetherHits   int
}

type playerState struct {
	Angle    float64
	InputDir int
	Lives    int
	IsAlive  bool
	LastSeq  uint32
}

type historyEntry struct {
	t                time.Time
	balls            []ballState
	players          []playerState
	currentBallSpeed float64
	nextBallAt       time.Time
	lastAccelAt      time.Time
	lastAddBallAt    time.Time
	startedAt        time.Time
	state            string
	winnerID         string
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

// RoomSummary is a public, JSON-friendly description of a room.
type RoomSummary struct {
	RoomID      string `json:"roomID"`
	Players     int    `json:"players"`
	MaxPlayers  int    `json:"maxPlayers"`
	State       string `json:"state"`
	HasPassword bool   `json:"hasPassword"`
}

// Summary returns a snapshot of the room for the public room list.
func (r *Room) Summary() RoomSummary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return RoomSummary{
		RoomID:      r.ID,
		Players:     len(r.Players),
		MaxPlayers:  r.MaxPlayers,
		State:       r.State,
		HasPassword: r.Password != "",
	}
}

// CheckPassword reports whether the given password grants access to the room.
func (r *Room) CheckPassword(password string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.Password == "" || r.Password == password
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
	r.Players = append(r.Players, p)

	// The match does not auto-start when the room fills up: the host starts it
	// explicitly (Room.Start) so everyone has a chance to get ready.
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

// Kick removes a player from the room (host only). In a running match the
// kicked player is treated as eliminated so the field re-forms.
func (r *Room) Kick(hostID, targetID string) (*Player, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.HostID != hostID {
		return nil, ErrNotHost
	}
	if hostID == targetID {
		return nil, ErrCannotKickSelf
	}
	idx := -1
	for i, p := range r.Players {
		if p.ID == targetID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil, ErrPlayerNotFound
	}

	target := r.Players[idx]
	r.Players = append(r.Players[:idx], r.Players[idx+1:]...)
	r.history = r.history[:0]

	if r.State == StatePlaying {
		r.onEliminationLocked()
		r.checkEndLocked()
	}
	return target, nil
}

// SetInput records the currently held movement direction for a player (no lag
// compensation). Used by tests.
func (r *Room) SetInput(id string, dir int, seq uint32) {
	r.HandleInput(id, dir, seq, 0)
}

// HandleInput applies a player's movement input. If the input was sent `lagMs`
// milliseconds ago, the simulation is rewound to that point and re-simulated so
// a late paddle move can still block a ball it "would have" blocked.
func (r *Room) HandleInput(id string, dir int, seq uint32, lagMs float64) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if dir > 1 {
		dir = 1
	}
	if dir < -1 {
		dir = -1
	}

	for _, p := range r.Players {
		if p.ID != id {
			continue
		}
		if seq <= p.LastSeq {
			return // stale or duplicate
		}
		if lagMs < 0 {
			lagMs = 0
		}
		if lagMs > maxRewindMs {
			lagMs = maxRewindMs
		}

		// Outside of active play there is no simulation to rewind; apply now.
		if r.State != StatePlaying {
			p.InputDir = dir
			p.LastSeq = seq
			return
		}

		// Anchor the input's "send time" in the simulation timeline rather than
		// the wall clock. The world (ball, paddles, history) only ever advances
		// in sim time, and sim time can drift slightly from the wall clock when
		// the ticker is late, so using the wall clock makes rewinds inconsistent
		// and lets paddles/balls jump.
		at := r.simTime.Add(-time.Duration(lagMs * float64(time.Millisecond)))
		p.Queue = append(p.Queue, queuedInput{Dir: dir, Seq: seq, At: at})

		// If the input is more than one tick in the past, rewind and re-simulate.
		if r.simTime.Sub(at) > time.Second/time.Duration(r.Config.TickRate) {
			r.rewindToLocked(at)
		}
		return
	}
}

// rewindToLocked restores the world to `at` and re-simulates forward to now,
// applying queued inputs as their time arrives.
func (r *Room) rewindToLocked(at time.Time) {
	snapIdx := -1
	for i := range r.history {
		if !r.history[i].t.After(at) {
			snapIdx = i
		}
	}
	if snapIdx < 0 {
		return
	}

	target := r.simTime // sim time the re-simulation must reach again
	snap := r.history[snapIdx]
	r.restoreLocked(&snap)

	// Drop any state recorded after the restore point: it no longer matches the
	// re-simulated timeline.
	r.history = r.history[:snapIdx+1]

	dt := 1.0 / float64(r.Config.TickRate)
	// Re-simulate exactly the ticks between the restored snapshot and the
	// original sim time. Using the sim-time delta (not the wall clock) keeps the
	// re-simulated timeline identical to the one already running, so a rewind
	// never advances the world past where it would have been and never makes
	// paddles/balls visibly jump.
	ticks := int(math.Round(target.Sub(snap.t).Seconds() / dt))
	if ticks < 0 {
		ticks = 0
	}
	if ticks > maxRewindTicks {
		ticks = maxRewindTicks
	}
	for i := 0; i < ticks; i++ {
		r.simTime = r.simTime.Add(time.Duration(dt * float64(time.Second)))
		r.simulate(dt, false)
	}
}

// pushHistoryLocked records the current world state for future rewinds.
func (r *Room) pushHistoryLocked() {
	e := historyEntry{
		t:                r.simTime,
		currentBallSpeed: r.currentBallSpeed,
		nextBallAt:       r.nextBallAt,
		lastAccelAt:      r.lastAccelAt,
		lastAddBallAt:    r.lastAddBallAt,
		startedAt:        r.startedAt,
		state:            r.State,
		winnerID:         r.WinnerID,
	}
	for _, b := range r.Balls {
		e.balls = append(e.balls, ballState{
			X: b.X, Y: b.Y, VX: b.VX, VY: b.VY,
			SpeedMul: b.SpeedMul, OnFire: b.OnFire, Curve: b.Curve, Sticky: b.Sticky,
			StuckUntil: b.StuckUntil, StuckToP: b.StuckToP, StuckT: b.StuckT,
			StuckNX: b.StuckNX, StuckNY: b.StuckNY,
			IsFake: b.IsFake, FakeOwner: b.FakeOwner,
			TetherOwner: b.TetherOwner, TetherTarget: b.TetherTarget, TetherHits: b.TetherHits,
		})
	}
	for _, p := range r.Players {
		e.players = append(e.players, playerState{
			Angle: p.Angle, InputDir: p.InputDir,
			Lives: p.Lives, IsAlive: p.IsAlive, LastSeq: p.LastSeq,
		})
	}
	r.history = append(r.history, e)
	if len(r.history) > maxHistory {
		r.history = r.history[len(r.history)-maxHistory:]
	}
}

// restoreLocked rolls the world back to a recorded snapshot. Player input
// queues and connections are intentionally left untouched.
func (r *Room) restoreLocked(snap *historyEntry) {
	r.simTime = snap.t
	r.currentBallSpeed = snap.currentBallSpeed
	r.nextBallAt = snap.nextBallAt
	r.lastAccelAt = snap.lastAccelAt
	r.lastAddBallAt = snap.lastAddBallAt
	r.startedAt = snap.startedAt
	r.State = snap.state
	r.WinnerID = snap.winnerID

	r.Balls = r.Balls[:0]
	for _, bs := range snap.balls {
		r.Balls = append(r.Balls, &Ball{
			X: bs.X, Y: bs.Y, VX: bs.VX, VY: bs.VY, Radius: r.Config.BallRadius,
			SpeedMul: bs.SpeedMul, OnFire: bs.OnFire, Curve: bs.Curve, Sticky: bs.Sticky,
			StuckUntil: bs.StuckUntil, StuckToP: bs.StuckToP, StuckT: bs.StuckT,
			StuckNX: bs.StuckNX, StuckNY: bs.StuckNY,
			IsFake: bs.IsFake, FakeOwner: bs.FakeOwner,
			TetherOwner: bs.TetherOwner, TetherTarget: bs.TetherTarget, TetherHits: bs.TetherHits,
		})
	}
	for i := range r.Players {
		if i >= len(snap.players) {
			break
		}
		ps := snap.players[i]
		r.Players[i].Angle = ps.Angle
		r.Players[i].InputDir = ps.InputDir
		r.Players[i].Lives = ps.Lives
		r.Players[i].IsAlive = ps.IsAlive
		r.Players[i].LastSeq = ps.LastSeq
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

// UpdateConfig changes the room's match settings (host only, outside a running
// match). Used before the first start and for a rematch.
func (r *Room) UpdateConfig(hostID string, lives int, accel bool, addBallTime int, items bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.HostID != hostID {
		return ErrNotHost
	}
	if r.State != StateWaiting && r.State != StateEnded {
		return ErrGameStarted
	}
	if lives < 1 {
		lives = 1
	}
	if lives > 5 {
		lives = 5
	}
	if addBallTime < 0 {
		addBallTime = 0
	}
	if addBallTime > 30 {
		addBallTime = 30
	}
	r.Config.Lives = lives
	r.Config.BallAccel = accel
	r.Config.Items = items
	if addBallTime > 0 {
		r.Config.AddBallInterval = float64(addBallTime)
	} else {
		r.Config.AddBallInterval = 0
	}
	return nil
}

// startLocked performs the actual start (caller must hold the write lock).
func (r *Room) startLocked() {
	cfg := r.Config
	for _, p := range r.Players {
		p.Angle = 0.5
		p.Lives = cfg.Lives
		p.IsAlive = true
	}

	r.rebuildGeometryLocked()

	r.currentBallSpeed = cfg.BallSpeed
	r.Balls = r.Balls[:0]
	r.spawnBallLocked(0)
	r.clearBallItemsLocked()
	r.resetItemsLocked()

	now := time.Now()
	r.startedAt = now
	r.simTime = now
	r.lastAccelAt = now
	r.lastAddBallAt = now
	r.nextBallAt = time.Time{}
	r.history = r.history[:0]
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

// rebuildGeometryLocked assigns faces to the surviving players and rebuilds the
// arena for the new player count (caller must hold the write lock). A regular
// polygon needs >= 3 sides, so a 2-player match uses a 4-sided arena where the
// two opposite faces are goals and the other two are plain walls.
func (r *Room) rebuildGeometryLocked() {
	type owner struct {
		p         *Player
		playerIdx int
	}
	alive := make([]owner, 0, len(r.Players))
	for i, p := range r.Players {
		if p.IsAlive {
			alive = append(alive, owner{p, i})
		}
	}

	n := len(alive)
	arenaSides := n
	if arenaSides == 2 {
		arenaSides = 4
	}
	r.Config.Sides = arenaSides

	for j, o := range alive {
		if n == 2 {
			o.p.Index = 2 * j
		} else {
			o.p.Index = j
		}
	}
	// Eliminated players become spectators: they own no face.
	for _, p := range r.Players {
		if !p.IsAlive {
			p.Index = -1
		}
	}

	r.faceOwner = make([]int, arenaSides)
	for i := range r.faceOwner {
		r.faceOwner[i] = -1
	}
	for _, o := range alive {
		r.faceOwner[o.p.Index] = o.playerIdx
	}

	r.buildGeometryLocked()
}

// onEliminationLocked re-forms the field for the remaining players and respawns
// any ball that ended up outside the new, smaller polygon.
func (r *Room) onEliminationLocked() {
	if r.State != StatePlaying {
		return
	}
	alive := 0
	for _, p := range r.Players {
		if p.IsAlive {
			alive++
		}
	}
	if alive < 2 {
		return
	}

	r.rebuildGeometryLocked()
	r.history = r.history[:0]
	for _, b := range r.Balls {
		if r.pointOutsideLocked(b.X, b.Y) {
			r.respawnBallLocked(b, r.randomAliveFaceLocked())
		}
	}
}

// pointOutsideLocked reports whether the point (x,y) lies outside the arena.
func (r *Room) pointOutsideLocked(x, y float64) bool {
	for _, seg := range r.Walls {
		mid := geometry.Mul(geometry.Add(seg.A, seg.B), 0.5)
		n := geometry.Norm(mid)
		if geometry.Len(n) == 0 {
			continue
		}
		c := geometry.Dot(seg.A, n)
		if geometry.Dot(geometry.Point{X: x, Y: y}, n) > c {
			return true
		}
	}
	return false
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
	X            float64 `json:"x"`
	Y            float64 `json:"y"`
	VX           float64 `json:"vx"`
	VY           float64 `json:"vy"`
	Fire         bool    `json:"fire,omitempty"`
	Cv           int     `json:"cv,omitempty"` // curve hits remaining (0 = not curving)
	Sticky       bool    `json:"sticky,omitempty"`
	Stuck        float64 `json:"stuck,omitempty"` // seconds still stuck
	Fake         bool    `json:"fake,omitempty"`
	Tether       bool    `json:"tether,omitempty"`
	TetherTarget string  `json:"tt,omitempty"`
	TetherHits   int     `json:"th,omitempty"`
}

type snapshotPlayer struct {
	ID      string             `json:"id"`
	Name    string             `json:"name"`
	Index   int                `json:"index"`
	Angle   float64            `json:"angle"`
	Lives   int                `json:"lives"`
	IsAlive bool               `json:"isAlive"`
	IsHost  bool               `json:"isHost"`
	LastSeq uint32             `json:"lastSeq"`
	Item    string             `json:"item,omitempty"` // held item ("" = none)
	Fx      map[string]float64 `json:"fx,omitempty"`   // effect -> seconds left
	Arm     string             `json:"arm,omitempty"`  // armed one-shot waiting for contact
	Use     string             `json:"use,omitempty"`  // item used a moment ago (icon key)
	UseT    float64            `json:"useT,omitempty"` // seconds the "just used" icon remains
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
	Lives       int              `json:"lives"`
	BallAccel   bool             `json:"ballAccel"`
	AddBallTime int              `json:"addBallTime"`
	Items       bool             `json:"items"`
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
		Lives:       r.Config.Lives,
		BallAccel:   r.Config.BallAccel,
		AddBallTime: int(r.Config.AddBallInterval),
		Items:       r.Config.Items,
		Players:     make([]snapshotPlayer, 0, len(r.Players)),
		Balls:       make([]snapshotBall, 0, len(r.Balls)),
	}
	if r.State == StateEnded {
		s.Winner = r.WinnerID
	}
	for _, p := range r.Players {
		fx := map[string]float64{}
		if t := p.ShieldT; t.After(now) {
			fx["shield"] = t.Sub(now).Seconds()
		}
		if t := p.FireArmT; t.After(now) {
			fx["fire"] = t.Sub(now).Seconds()
		}
		if t := p.StickyArmT; t.After(now) {
			fx["sticky"] = t.Sub(now).Seconds()
		}
		if t := p.FrozenT; t.After(now) {
			fx["frozen"] = t.Sub(now).Seconds()
		}
		if t := p.BlindT; t.After(now) {
			fx["blind"] = t.Sub(now).Seconds()
		}
		if t := p.ShakeT; t.After(now) {
			fx["shake"] = t.Sub(now).Seconds()
		}
		if len(fx) == 0 {
			fx = nil
		}
		s.Players = append(s.Players, snapshotPlayer{
			ID: p.ID, Name: p.Name, Index: p.Index,
			Angle: p.Angle, Lives: p.Lives,
			IsAlive: p.IsAlive, IsHost: p.IsHost,
			LastSeq: p.LastSeq,
			Item:    itemKey(p.Item),
			Fx:      fx,
			Arm:     playerArmKey(p),
			Use:     playerUseKey(p, now),
			UseT:    playerUseSec(p, now),
		})
	}
	for _, b := range r.Balls {
		stuck := 0.0
		if !b.StuckUntil.IsZero() && b.StuckUntil.After(now) {
			stuck = b.StuckUntil.Sub(now).Seconds()
		}
		s.Balls = append(s.Balls, snapshotBall{
			X: b.X, Y: b.Y, VX: b.VX, VY: b.VY,
			Fire: b.OnFire, Cv: b.Curve, Sticky: b.Sticky, Stuck: stuck,
			Fake: b.IsFake, Tether: b.TetherTarget != "",
			TetherTarget: b.TetherTarget, TetherHits: b.TetherHits,
		})
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
