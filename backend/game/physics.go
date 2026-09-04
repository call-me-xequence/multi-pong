package game

import (
	"math"
	"math/rand/v2"
	"time"

	"neonpong/geometry"
)

// Update advances the simulation by dt seconds (one tick).
func (r *Room) Update(dt float64) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.State != StatePlaying {
		return
	}
	r.simTime = r.simTime.Add(time.Duration(dt * float64(time.Second)))
	r.pushHistoryLocked()
	r.simulate(dt, true)
}

// simulate runs one simulation tick. The caller must hold the write lock.
// timedEvents disables slow periodic events (accel / add-ball / respawn) during
// a rewind re-simulation so they don't fire twice.
func (r *Room) simulate(dt float64, timedEvents bool) {
	if r.State != StatePlaying {
		return
	}
	r.drainInputsLocked()
	// Decide each bot's held input for this tick before the paddles move, so a
	// bot paddle reacts within the same tick as the ball it is tracking.
	r.botThinkLocked()

	cfg := r.Config
	now := time.Now()

	// 1. Move paddles from held inputs (frozen players are 50% slower).
	faceLen := cfg.FaceLength()
	if faceLen > 0 {
		for _, p := range r.Players {
			if !p.IsAlive || p.InputDir == 0 {
				continue
			}
			p.Angle += float64(p.InputDir) * (cfg.PaddleSpeed * r.frozenSpeedFactor(p) / faceLen) * dt
			half := cfg.PaddleHalf()
			if p.Angle < half {
				p.Angle = half
			}
			if p.Angle > 1-half {
				p.Angle = 1 - half
			}
		}
	}

	if timedEvents {
		// Item drops and armed/debuff timers.
		r.dropTickLocked(now)
		r.tickItemTimersLocked(now)

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
	}

	// 4. Drop fake balls that left their owner's zone (pre-pass, avoids mutating
	// the slice while we iterate).
	r.removeFakeOutsideZoneLocked()

	// 5. Integrate balls and resolve collisions. Goals are collected and applied
	// after the loop so balls can be safely removed while iterating.
	var goalBalls []*Ball
	var goalPlayers []*Player
	for _, b := range r.Balls {
		// A sticky ball only stays sticky for a short while, then behaves like a
		// normal ball again (no endless clinging for the rest of the rally).
		if b.Sticky && !b.StickyUntil.IsZero() && now.After(b.StickyUntil) {
			b.Sticky = false
			b.StickyUntil = time.Time{}
		}

		// Sticky ball handling (stuck to a paddle/wall for a short moment).
		if !b.StuckUntil.IsZero() {
			if b.StuckUntil.After(now) {
				// Still stuck: follow the paddle it is stuck to. The ball keeps its
				// offset from the paddle centre, so it rides along as the paddle
				// moves. A ball stuck to a wall simply stays put.
				if b.StuckToP != "" {
					if p := r.playerByID(b.StuckToP); p != nil && p.IsAlive && p.Index >= 0 {
						seg := r.Faces[p.Index]
						ab := geometry.Sub(seg.B, seg.A)
						nn := geometry.Norm(geometry.Mul(geometry.Add(seg.A, seg.B), 0.5))
						coord := p.Angle + b.StuckT
						if coord < 0 {
							coord = 0
						} else if coord > 1 {
							coord = 1
						}
						pos := geometry.Add(seg.A, geometry.Mul(ab, coord))
						b.X = pos.X - nn.X*b.Radius
						b.Y = pos.Y - nn.Y*b.Radius
					}
				}
				continue
			}
			// Stick window over: resume as a normal (delayed) bounce so the ball
			// can't get locked bouncing perpendicular between parallel walls.
			r.releaseStuckBallLocked(b)
			continue
		}

		// Curve balls bend their path continuously (predictable on the client).
		r.applyCurveLocked(b, dt)

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
			// Tethered balls snap back to their anchor when the rope is taut.
			r.tickTetherLocked(b)
			r.containBallLocked(b)
		}
	}
	for i := range goalBalls {
		r.applyGoalLocked(goalBalls[i], goalPlayers[i])
	}
}

// drainInputsLocked applies queued player inputs whose time has come.
func (r *Room) drainInputsLocked() {
	for _, p := range r.Players {
		if len(p.Queue) == 0 {
			continue
		}
		kept := p.Queue[:0]
		for _, in := range p.Queue {
			if in.Seq <= p.LastSeq {
				continue // stale or duplicate
			}
			if !in.At.After(r.simTime) {
				p.InputDir = in.Dir
				p.LastSeq = in.Seq
			} else {
				kept = append(kept, in)
			}
		}
		p.Queue = kept
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

	// The drawn paddle is the raw face segment, but the ball is a circle of
	// radius b.Radius: when it grazes the paddle's end, the ball's disc still
	// visibly touches the tip even though its centre projects a little beyond
	// the segment. Extend the block zone by the ball radius at both tips so
	// those edge hits bounce instead of counting as a goal (matches what the
	// player actually sees). Steering stays normalised to the drawn paddle.
	faceLen := math.Sqrt(lenSq)
	if faceLen <= 0 {
		return false
	}
	hitHalf := half + b.Radius/faceLen

	// Only consider projections that actually land on the face segment.
	if rawT < 0 || rawT > 1 {
		return false
	}
	t := rawT

	// Paddle zone (tips included): bounce the ball back.
	if t >= center-hitHalf && t <= center+hitHalf {
		if outward > 0 && sdNow >= -b.Radius {
			if b.Sticky || !p.StickyArmT.IsZero() {
				// The arming contact of the sticky item sticks to the paddle too.
				if !b.Sticky {
					b.Sticky = true
					b.StickyUntil = time.Now().Add(time.Duration(stickyBallLife * float64(time.Second)))
					p.StickyArmT = time.Time{}
				}
				// Sticky ball clings to the paddle for a moment.
				r.stickToPaddleLocked(b, seg, n, p, t)
				return false
			}
			r.bouncePaddle(b, seg, n, t, center, half)
			r.triggerItemOnPaddleHitLocked(b, p)
		}
		return false
	}

	// Goal zone: the ball crossed the face line from inside to outside.
	if outward > 0 && sdPrev < 0 && sdNow >= 0 {
		if p.ShieldT.After(time.Now()) {
			// The shield makes the goal impenetrable: reflect the ball off the
			// whole face and break.
			p.ShieldT = time.Time{}
			r.bouncePaddle(b, seg, n, t, 0.5, 0.5)
			return false
		}
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
	if b.Sticky {
		// Sticky ball clings to the wall for a short moment, then resumes as a
		// normal bounce. Remember its incoming direction so the release keeps its
		// tangential motion: otherwise a sticky ball can end up bouncing straight
		// back and forth between parallel walls, out of everyone's reach.
		now := time.Now()
		spd := math.Hypot(b.VX, b.VY)
		if spd > 0 {
			b.StuckNX, b.StuckNY = b.VX/spd, b.VY/spd
		} else {
			b.StuckNX, b.StuckNY = nx, ny
		}
		b.StuckUntil = now.Add(time.Duration(stickyStickTime * float64(time.Second)))
		b.StuckToP = ""
		b.StuckT = 0
		b.X = closest.X + nx*b.Radius
		b.Y = closest.Y + ny*b.Radius
		b.VX, b.VY = 0, 0
		return
	}
	dot := b.VX*nx + b.VY*ny
	if dot < 0 {
		b.VX -= 2 * dot * nx
		b.VY -= 2 * dot * ny
	}

	// Push the ball out of the wall.
	b.X = closest.X + nx*b.Radius
	b.Y = closest.Y + ny*b.Radius
}

// releaseStuckBallLocked ends a sticky ball's pause and puts it back in motion
// as a normal (delayed) bounce. A ball caught on a paddle bounces off the
// paddle's current position (the paddle may have dragged the ball while it was
// stuck); a ball stuck to a wall reflects its pre-stick direction about the
// wall, so its tangential motion is preserved and it can never be trapped
// bouncing perpendicular between parallel walls.
func (r *Room) releaseStuckBallLocked(b *Ball) {
	b.StuckUntil = time.Time{}
	pid := b.StuckToP
	b.StuckToP = ""

	// The unit direction the ball was flying when it became stuck.
	dx, dy := b.StuckNX, b.StuckNY

	if pid != "" {
		if p := r.playerByID(pid); p != nil && p.IsAlive && p.Index >= 0 {
			seg := r.Faces[p.Index]
			n := geometry.Norm(geometry.Mul(geometry.Add(seg.A, seg.B), 0.5))
			half := r.Config.PaddleHalf()
			if dx == 0 && dy == 0 {
				// No recorded direction: assume it was heading into the goal so the
				// paddle bounce sends it back into the field.
				dx, dy = n.X, n.Y
			}
			b.VX, b.VY = dx, dy
			r.bouncePaddle(b, seg, n, p.Angle+b.StuckT, p.Angle, half)
			return
		}
	}

	// Wall (or the paddle it was stuck to is gone): reflect off the surface it
	// is resting on; if that fails, head back toward the arena centre.
	if dx != 0 || dy != 0 {
		if vx, vy, ok := r.wallReleaseDirLocked(b, dx, dy); ok {
			b.VX = vx * r.ballSpeed(b)
			b.VY = vy * r.ballSpeed(b)
			return
		}
	}
	b.VX, b.VY = r.towardCentreDir(b)
	b.VX *= r.ballSpeed(b)
	b.VY *= r.ballSpeed(b)
}

// wallReleaseDirLocked reflects the unit direction (dx,dy) about the arena wall
// the ball is currently resting on (the normal points from the wall to the
// ball). Returns ok=false when no wall is near enough to reflect against.
func (r *Room) wallReleaseDirLocked(b *Ball, dx, dy float64) (float64, float64, bool) {
	for _, seg := range r.Walls {
		closest := geometry.ClosestPointOnSegment(geometry.Point{X: b.X, Y: b.Y}, seg)
		nx := b.X - closest.X
		ny := b.Y - closest.Y
		d := math.Hypot(nx, ny)
		if d >= b.Radius+1e-6 || d < 1e-9 {
			continue
		}
		nx, ny = nx/d, ny/d
		dot := dx*nx + dy*ny
		return dx - 2*dot*nx, dy - 2*dot*ny, true
	}
	return 0, 0, false
}

// towardCentreDir returns a unit vector pointing from the ball back to the
// arena centre (0,0), used as a safe fallback release direction.
func (r *Room) towardCentreDir(b *Ball) (float64, float64) {
	dx, dy := -b.X, -b.Y
	d := math.Hypot(dx, dy)
	if d < 1e-9 {
		return 0, 1
	}
	return dx / d, dy / d
}

// containBallLocked respawns a ball that somehow escaped the arena.
func (r *Room) containBallLocked(b *Ball) {
	if math.Hypot(b.X, b.Y) > r.Config.Radius*1.6 {
		r.clearBallEffectsLocked(b)
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

// normalizeBallLocked sets the ball's velocity magnitude to the current ball
// speed (times its fire multiplier when on fire).
func (r *Room) normalizeBallLocked(b *Ball) {
	spd := math.Hypot(b.VX, b.VY)
	target := r.ballSpeed(b)
	if spd == 0 {
		angle := rand.Float64() * 2 * math.Pi
		b.VX = target * math.Cos(angle)
		b.VY = target * math.Sin(angle)
		return
	}
	b.VX = b.VX / spd * target
	b.VY = b.VY / spd * target
}
