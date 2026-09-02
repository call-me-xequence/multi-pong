package server

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"neonpong/game"
)

type createRoomRequest struct {
	MaxPlayers  int  `json:"maxPlayers"`
	LivesCount  int  `json:"livesCount"`
	BallAccel   bool `json:"ballAccel"`
	AddBallTime int  `json:"addBallTime"` // seconds, 0 = disabled
}

// CreateRoomHandler handles POST /create-room.
func (h *Hub) CreateRoomHandler(c *gin.Context) {
	var req createRoomRequest
	if err := c.ShouldBindJSON(&req); err != nil && err.Error() != "EOF" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
		return
	}

	if req.MaxPlayers < 2 {
		req.MaxPlayers = 2
	}
	if req.MaxPlayers > 6 {
		req.MaxPlayers = 6
	}
	if req.LivesCount < 1 {
		req.LivesCount = 1
	}
	if req.LivesCount > 5 {
		req.LivesCount = 5
	}
	if req.AddBallTime < 0 {
		req.AddBallTime = 0
	}
	if req.AddBallTime > 30 {
		req.AddBallTime = 30
	}

	cfg := game.DefaultConfig()
	cfg.Lives = req.LivesCount
	cfg.BallAccel = req.BallAccel
	if req.AddBallTime > 0 {
		cfg.AddBallInterval = float64(req.AddBallTime)
	} else {
		cfg.AddBallInterval = 0
	}

	room := h.CreateRoom(cfg, req.MaxPlayers)
	c.JSON(http.StatusOK, gin.H{
		"roomID":     room.ID,
		"maxPlayers": req.MaxPlayers,
		"lives":      req.LivesCount,
	})
}

// ListRoomsHandler handles GET /rooms.
func (h *Hub) ListRoomsHandler(c *gin.Context) {
	rooms := h.ListRooms()
	type roomInfo struct {
		RoomID     string `json:"roomID"`
		Players    int    `json:"players"`
		MaxPlayers int    `json:"maxPlayers"`
		State      string `json:"state"`
	}
	list := make([]roomInfo, 0, len(rooms))
	for _, r := range rooms {
		id, players, maxPlayers, state := r.Info()
		list = append(list, roomInfo{RoomID: id, Players: players, MaxPlayers: maxPlayers, State: state})
	}
	c.JSON(http.StatusOK, gin.H{"rooms": list})
}
