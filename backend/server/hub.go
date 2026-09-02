package server

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"neonpong/game"
)

// Hub owns all active rooms.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*game.Room
}

// NewHub creates a hub and starts its cleanup loop.
func NewHub() *Hub {
	h := &Hub{rooms: make(map[string]*game.Room)}
	go h.reapLoop()
	return h
}

// CreateRoom builds a room, starts its game loop and registers it.
func (h *Hub) CreateRoom(cfg *game.GameConfig, maxPlayers int) *game.Room {
	id := randomID()
	r := game.NewRoom(id, cfg, maxPlayers)
	r.SetDoneCallback(func() {
		h.mu.Lock()
		delete(h.rooms, id)
		h.mu.Unlock()
	})

	h.mu.Lock()
	h.rooms[id] = r
	h.mu.Unlock()

	go r.RunLoop()
	return r
}

// GetRoom looks up a room by ID.
func (h *Hub) GetRoom(id string) (*game.Room, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	r, ok := h.rooms[id]
	return r, ok
}

// ListRooms returns a snapshot of all rooms.
func (h *Hub) ListRooms() []*game.Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	list := make([]*game.Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		list = append(list, r)
	}
	return list
}

// reapLoop removes empty rooms periodically (after a grace period so that a
// freshly created room isn't deleted before the host has a chance to share it).
func (h *Hub) reapLoop() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	const grace = 2 * time.Minute
	for range t.C {
		h.mu.Lock()
		for id, r := range h.rooms {
			_, players, _, _ := r.Info()
			if players == 0 && time.Since(r.CreatedAt) > grace {
				r.Stop()
				delete(h.rooms, id)
			}
		}
		h.mu.Unlock()
	}
}

func randomID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
