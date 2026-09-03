package game

import (
	"math"
	"math/rand/v2"
	"time"

	"neonpong/geometry"
)

// Update advances the simulation by dt seconds.
func (r *Room) Update(dt float64) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.State != StatePlaying {
		return
	}

	cfg := r.Config
	now := time.Now()

	// 1. Move paddles from held inputs.
	faceLen := cfg.FaceLength()
	if faceLen > 0 {
		for _, p := range r.Players {
			if !p.IsAlive || p.InputDir == 0 {
				continue
			}
			p.Angle += float64(p.InputDir) * (cfg.PaddleSpeed / faceLen) * dt
			half := cfg.PaddleHalf()
			if p.Angle < half {
				p.Angle = half
			}
			if p.Angle > 1-half {
				p.Angle = 1 - half
			}
		}
	}

	// 2. Periodic ball acceleration (+AccelFactor every AccelInterval seconds).
	if cfg.BallAccel && now.Sub(r.lastAccelAt).Seconds() >= cfg.AccelInterval {
		r.currentBallSpeed *= cfg.AccelFactor
		if r.currentBallSpeed > cfg.BallSpeedMax {
			r.currentBallSpeed = cfg.BallSpeedMax
		}
		r.lastAccelAt = now
		r.renormalizeBallsLocked()
	}

	// 3. Respawn a ball after a goal (short pause) and add extra balls on an
	// interval (up to MaxBalls).
	if !r.nextBallAt.IsZero() {
		if now.After(r.nextBallAt) {
			if len(r.Balls) < cfg.MaxBalls {
				r.spawnBallLocked(r.randomAliveFaceLocked())
			}
			r.nextBallAt = time.Time{}
		}
	} else if cfg.AddBallInterval > 0 && len(r.Balls) < cfg.MaxBalls &&
		now.Sub(r.lastAddBallAt).Seconds() >= cfg.AddBallInterval {
		r.spawnBallLocked(-1)
		r.lastAddBallAt = now
	}

	// 4. Integrate balls and resolve collisions. Goals are collected and applied
	// after the loop so balls can be safely removed while iterating.
	var goalBalls []*Ball
	var goalPlayers []*Player
	for _, b := range r.Balls {
		px, py := b.X, b.Y
		b.X += b.VX * dt
		b.Y += b.VY * dt

		scored := false
		for si, seg := range r.Walls {
			if si%2 == 0 { // goal face
				face := si / 2
				if face < len(r.faceOwner) && r.faceOwner[face] >= 0 {
					p := r.Players[r.faceOwner[face]]
					if p.IsAlive {
						if r.handleFace(b, seg, p, px, py) {
							goalBalls = append(goalBalls, b)
							goalPlayers = append(goalPlayers, p)
							scored = true
							break
						}
						continue
					}
				}
			}
			r.collideWall(b, seg)
		}

		if !scored {
			r.containBallLocked(b)
		}
	}
	for i := range goalBalls {
		r.applyGoalLocked(goalBalls[i], goalPlayers[i])
	}
}

// handleFace handles interaction with a live player's goal face.
// It returns true if a goal was scored. px/py is the ball's previous position.
func (r *Room) handleFace(b *Ball, seg geometry.Segment, p *Player, px, py float64) bool {
	cfg := r.Config
	ab := geometry.Sub(seg.B, seg.A)
	lenSq := geometry.Dot(ab, ab)
	if lenSq <= 0 {
		return false
	}

	// Outward normal: the face midpoint points away from the center (0,0).
	mid := geometry.Mul(geometry.Add(seg.A, seg.B), 0.5)
	n := geometry.Norm(mid)
	if geometry.Len(n) == 0 {
		return false
	}

	cur := geometry.Point{X: b.X, Y: b.Y}
	prev := geometry.Point{X: px, Y: py}

	rawT := geometry.Dot(geometry.Sub(cur, seg.A), ab) / lenSq
	outward := b.VX*n.X + b.VY*n.Y

	sdPrev := geometry.Dot(geometry.Sub(prev, seg.A), n)
	sdNow := geometry.Dot(geometry.Sub(cur, seg.A), n)

	half := cfg.PaddleHalf()
	center := p.Angle

	// Only consider projections that actually land on the face segment.
	if rawT < 0 || rawT > 1 {
		return false
	}
	t := rawT

	// Paddle zone: bounce the ball back.
	if t >= center-half && t <= center+half {
		if outward > 0 && sdNow >= -b.Radius {
			r.bouncePaddle(b, seg, n, t, center, half)
		}
		return false
	}

	// Goal zone: the ball crossed the face line from inside to outside.
	if outward > 0 && sdPrev < 0 && sdNow >= 0 {
		return true
	}
	return false
}

// bouncePaddle reflects the ball off the paddle, steering it based on hit offset.
func (r *Room) bouncePaddle(b *Ball, seg geometry.Segment, n geometry.Point, t, center, half float64) {
	// Reflect the normal (outward) component of the velocity.
	dot := b.VX*n.X + b.VY*n.Y
	if dot < 0 {
		dot = 0 // never accelerate the ball into the wall
	}
	b.VX -= 2 * dot * n.X
	b.VY -= 2 * dot * n.Y

	// Steer by hit position: -1..1 across the paddle.
	offset := (t - center) / half
	if offset > 1 {
		offset = 1
	}
	if offset < -1 {
		offset = -1
	}
	tangent := geometry.Perp(n)
	b.VX += tangent.X * offset * r.currentBallSpeed * 0.7
	b.VY += tangent.Y * offset * r.currentBallSpeed * 0.7

	r.normalizeBallLocked(b)

	// Push the ball back inside the face line so it doesn't stick.
	sd := geometry.Dot(geometry.Sub(geometry.Point{X: b.X, Y: b.Y}, seg.A), n)
	if sd > -b.Radius {
		push := sd + b.Radius
		b.X -= n.X * push
		b.Y -= n.Y * push
	}
}

// collideWall reflects the ball off a plain wall segment.
func (r *Room) collideWall(b *Ball, seg geometry.Segment) {
	closest := geometry.ClosestPointOnSegment(geometry.Point{X: b.X, Y: b.Y}, seg)
	dx := b.X - closest.X
	dy := b.Y - closest.Y
	d := math.Hypot(dx, dy)
	if d >= b.Radius || d == 0 {
		return
	}

	nx, ny := dx/d, dy/d
	dot := b.VX*nx + b.VY*ny
	if dot < 0 {
		b.VX -= 2 * dot * nx
		b.VY -= 2 * dot * ny
	}

	// Push the ball out of the wall.
	b.X = closest.X + nx*b.Radius
	b.Y = closest.Y + ny*b.Radius
}

// containBallLocked respawns a ball that somehow escaped the arena.
func (r *Room) containBallLocked(b *Ball) {
	if math.Hypot(b.X, b.Y) > r.Config.Radius*1.6 {
		r.respawnBallLocked(b, -1)
	}
}

// applyGoalLocked applies a goal against a player, removes the ball and, if the
// arena is now empty, schedules the next ball after a short pause.
func (r *Room) applyGoalLocked(b *Ball, p *Player) {
	p.Lives--
	eliminated := false
	if p.Lives <= 0 {
		p.Lives = 0
		p.IsAlive = false
		eliminated = true
	}

	r.removeBallLocked(b)
	if eliminated {
		r.onEliminationLocked()
	}
	if len(r.Balls) == 0 {
		r.nextBallAt = time.Now().Add(time.Duration(r.Config.RespawnDelay * float64(time.Second)))
	}
	r.checkEndLocked()
}

// eliminateLocked marks a disconnected player as dead, re-forms the field and
// checks for a winner.
func (r *Room) eliminateLocked(id string) {
	for _, p := range r.Players {
		if p.ID == id {
			p.IsAlive = false
			p.Lives = 0
			break
		}
	}
	r.onEliminationLocked()
	r.checkEndLocked()
}

// checkEndLocked ends the match when at most one player remains.
func (r *Room) checkEndLocked() {
	if r.State != StatePlaying {
		return
	}
	alive := make([]*Player, 0, len(r.Players))
	for _, p := range r.Players {
		if p.IsAlive {
			alive = append(alive, p)
		}
	}
	if len(alive) <= 1 {
		r.State = StateEnded
		if len(alive) == 1 {
			r.WinnerID = alive[0].ID
		}
	}
}

// renormalizeBallsLocked snaps every ball's speed to the current ball speed.
func (r *Room) renormalizeBallsLocked() {
	for _, b := range r.Balls {
		r.normalizeBallLocked(b)
	}
}

// normalizeBallLocked sets the ball's velocity magnitude to currentBallSpeed.
func (r *Room) normalizeBallLocked(b *Ball) {
	spd := math.Hypot(b.VX, b.VY)
	if spd == 0 {
		angle := rand.Float64() * 2 * math.Pi
		b.VX = r.currentBallSpeed * math.Cos(angle)
		b.VY = r.currentBallSpeed * math.Sin(angle)
		return
	}
	b.VX = b.VX / spd * r.currentBallSpeed
	b.VY = b.VY / spd * r.currentBallSpeed
}
