package game

// Bot players. A "bot room" is a private match where the server fills the seats
// with AI players. Bots are full Room players (they own a face and appear in
// snapshots to the human) but have no WebSocket: the AI sets their InputDir
// every tick inside Room.simulate, so they need no lag compensation and react
// almost instantly.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"time"

	"neonpong/geometry"
)

// Bot tuning.
const (
	botSubHz    = 240.0  // trajectory-prediction substeps per second
	botHorizon  = 3.0    // how many seconds of ball flight to look ahead
	botDeadZone = 0.0035 // paddle dead zone as a fraction of the face (anti-jitter)
)

// botPlayerName returns the display name for the i-th bot in a room (0-based).
func botPlayerName(i int) string {
	if i == 0 {
		return "🤖 Бот"
	}
	return fmt.Sprintf("🤖 Бот %d", i+1)
}

func randomBotID() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return "bot-" + hex.EncodeToString(b)
}

// --- Room lifecycle helpers ------------------------------------------------

// IsBotRoom reports whether the room is a private match against bot players.
func (r *Room) IsBotRoom() bool { return r.BotCount > 0 }

// ensureBotsLocked keeps exactly BotCount bots in the room (caller holds the
// write lock). Called after a human joins so the human is always the host.
func (r *Room) ensureBotsLocked() {
	if r.BotCount <= 0 {
		return
	}
	have := 0
	for _, p := range r.Players {
		if p.IsBot {
			have++
		}
	}
	for have < r.BotCount {
		p := NewPlayer(randomBotID(), botPlayerName(have))
		p.IsBot = true
		r.Players = append(r.Players, p)
		have++
	}
}

func (r *Room) hasHumanLocked() bool {
	for _, p := range r.Players {
		if !p.IsBot {
			return true
		}
	}
	return false
}

// cleanupBotsLocked tears a bot room down once the last human has left: the bots
// are dropped and the room loop is stopped (so the hub removes it). Caller holds
// the write lock; Stop only closes the done channel, so it is safe under lock.
func (r *Room) cleanupBotsLocked() {
	if !r.IsBotRoom() || r.hasHumanLocked() {
		return
	}
	kept := r.Players[:0]
	for _, p := range r.Players {
		if !p.IsBot {
			kept = append(kept, p)
		}
	}
	r.Players = kept
	r.HostID = ""
	r.history = r.history[:0]
	r.State = StateWaiting
	r.Stop()
}

// --- AI --------------------------------------------------------------------

// botThinkLocked chooses the movement input for every bot player for this tick.
// A bot chases the ball whose trajectory will next cross its own goal face (the
// earliest intercept) and parks its paddle on that crossing point. With no
// threat it returns to the centre of its face. When the full trajectory
// predictor fails (corner shots, curve balls it can't resolve, ...), it falls
// back to tracking the nearest ball that is flying toward its goal line.
//
// A blinded bot (the player used the "flash" item on it) cannot chase until a
// ball re-enters its own zone, mirroring the human-side reveal rule.
func (r *Room) botThinkLocked() {
	if r.State != StatePlaying {
		return
	}
	now := time.Now()
	for _, p := range r.Players {
		if !p.IsBot || !p.IsAlive || p.Index < 0 {
			continue
		}
		target := 0.5
		blinded := p.BlindT.After(now) && !r.anyBallInZoneLocked(p)
		if !blinded {
			bestArrive := -1.0
			for _, b := range r.Balls {
				arrive, tFace, ok := r.predictIntercept(b, p.Index)
				if !ok || (bestArrive >= 0 && arrive >= bestArrive) {
					continue
				}
				bestArrive = arrive
				target = tFace
			}
			if bestArrive < 0 {
				// Fallback: face the nearest ball that is currently heading
				// toward the goal line (outward, in front of the face).
				if t, ok := r.nearestFacewardBallLocked(p); ok {
					target = t
				}
			}
		}
		p.InputDir = botDirToward(p.Angle, target)
	}
}

// nearestFacewardBallLocked picks the ball that would next reach player p's goal
// line by simple line-of-sight (no wall prediction): the one flying outward with
// the smallest time-to-crossing. It returns the coordinate (0..1) along the face
// to park the paddle on, and whether such a ball exists.
func (r *Room) nearestFacewardBallLocked(p *Player) (float64, bool) {
	if p.Index < 0 {
		return 0, false
	}
	seg := r.Faces[p.Index]
	ab := geometry.Sub(seg.B, seg.A)
	lenSq := geometry.Dot(ab, ab)
	if lenSq <= 0 {
		return 0, false
	}
	mid := geometry.Mul(geometry.Add(seg.A, seg.B), 0.5)
	n := geometry.Norm(mid)
	if geometry.Len(n) == 0 {
		return 0, false
	}
	bestT := -1.0
	bestCoord := 0.5
	for _, b := range r.Balls {
		if !b.StuckUntil.IsZero() && b.StuckUntil.After(time.Now()) {
			continue
		}
		dot := b.VX*n.X + b.VY*n.Y
		if dot <= 0 {
			continue // moving away from the face
		}
		sd := (b.X-seg.A.X)*n.X + (b.Y-seg.A.Y)*n.Y
		if sd >= 0 {
			continue // already on/over the goal line
		}
		coord := ((b.X-seg.A.X)*ab.X + (b.Y-seg.A.Y)*ab.Y) / lenSq
		if coord < 0 || coord > 1 {
			continue // not in front of the face segment
		}
		tt := -sd / dot // seconds until the centre crosses the plane
		if bestT < 0 || tt < bestT {
			bestT = tt
			bestCoord = coord
		}
	}
	if bestT < 0 {
		return 0, false
	}
	return bestCoord, true
}

// botDirToward returns the paddle input (+1 right, -1 left, 0 idle) that moves
// the paddle angle toward target.
func botDirToward(angle, target float64) int {
	if target > angle+botDeadZone {
		return 1
	}
	if target < angle-botDeadZone {
		return -1
	}
	return 0
}

// predictIntercept simulates ball b forward from its current state, reflecting
// off every arena wall except the defender's own goal face. The defender's face
// is the target: the first time the trajectory crosses that face (a goal line
// crossing the bot must cover) is the intercept. It returns the arrival time in
// seconds and the crossing coordinate (0..1) along the defender's face.
func (r *Room) predictIntercept(b *Ball, face int) (arrive float64, tFace float64, ok bool) {
	cfg := r.Config
	seg := r.Faces[face]
	ab := geometry.Sub(seg.B, seg.A)
	lenSq := geometry.Dot(ab, ab)
	if lenSq <= 0 {
		return 0, 0, false
	}

	// Face outward normal (from the arena centre through the face midpoint).
	mid := geometry.Mul(geometry.Add(seg.A, seg.B), 0.5)
	n := geometry.Norm(mid)
	if geometry.Len(n) == 0 {
		return 0, 0, false
	}

	// Stuck balls are momentarily motionless; don't chase them.
	if !b.StuckUntil.IsZero() && b.StuckUntil.After(time.Now()) {
		return 0, 0, false
	}

	px, py := b.X, b.Y
	vx, vy := b.VX, b.VY
	spd := math.Hypot(vx, vy)
	if spd == 0 {
		return 0, 0, false
	}

	// Curve: remaining "bending time" budget (mirrors the server Curve counter).
	curveLeft := 0.0
	if b.Curve > 0 && cfg.TickRate > 0 {
		curveLeft = float64(b.Curve) / float64(cfg.TickRate)
	}

	a := seg.A
	rad := cfg.BallRadius
	dt := 1.0 / botSubHz
	steps := int(botHorizon * botSubHz)
	elapsed := 0.0
	for i := 0; i < steps; i++ {
		elapsed += dt

		// Curve balls bend continuously (same angular rate as applyCurveLocked).
		if curveLeft > 0 {
			c := math.Cos(curveRate * dt)
			s := math.Sin(curveRate * dt)
			nx, ny := vx, vy
			vx = nx*c - ny*s
			vy = nx*s + ny*c
			curveLeft -= dt
			if curveLeft < 0 {
				curveLeft = 0
			}
		}

		px2 := px + vx*dt
		py2 := py + vy*dt

		// Crossing of the defender's face plane (ball centre crosses the line).
		sdPrev := (px-a.X)*n.X + (py-a.Y)*n.Y
		sdNow := (px2-a.X)*n.X + (py2-a.Y)*n.Y
		if sdPrev < 0 && sdNow >= 0 {
			f := sdPrev / (sdPrev - sdNow)
			cx := px + (px2-px)*f
			cy := py + (py2-py)*f
			t := ((cx-a.X)*ab.X + (cy-a.Y)*ab.Y) / lenSq
			if t >= 0 && t <= 1 {
				return elapsed, t, true
			}
			// Crossing lands beyond the segment ends: that is a chamfered corner,
			// so the wall loop below reflects it like any other wall.
		}

		// Reflect off the other walls (chamfer, unowned faces and the other live
		// players' faces, which we assume are defended).
		px, py = px2, py2
		for pass := 0; pass < 2; pass++ {
			reflected := false
			for si, w := range r.Walls {
				if si%2 == 0 && si/2 == face {
					continue // the defender's own face is handled above
				}
				closest := geometry.ClosestPointOnSegment(geometry.Point{X: px, Y: py}, w)
				dx := px - closest.X
				dy := py - closest.Y
				d := math.Hypot(dx, dy)
				if d >= rad || d < 1e-9 {
					continue
				}
				nnx, nny := dx/d, dy/d
				dot := vx*nnx + vy*nny
				if dot < 0 {
					vx -= 2 * dot * nnx
					vy -= 2 * dot * nny
				}
				// Push back out so the reflection is not retriggered next pass.
				px = closest.X + nnx*rad
				py = closest.Y + nny*rad
				reflected = true
			}
			if !reflected {
				break
			}
		}
	}
	return 0, 0, false
}
