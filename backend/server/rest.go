package server

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"neonpong/game"
)

type createRoomRequest struct {
	Name        string `json:"name"`
	Password    string `json:"password"`
	MaxPlayers  int    `json:"maxPlayers"`
	LivesCount  int    `json:"livesCount"`
	BallAccel   bool   `json:"ballAccel"`
	AddBallTime int    `json:"addBallTime"` // seconds, 0 = disabled
	Items       bool   `json:"items"`       // enable power-up items
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
	cfg.Items = req.Items
	if req.AddBallTime > 0 {
		cfg.AddBallInterval = float64(req.AddBallTime)
	} else {
		cfg.AddBallInterval = 0
	}

	room, err := h.CreateRoom(req.Name, req.Password, cfg, req.MaxPlayers)
	if err != nil {
		status := http.StatusConflict
		if err == game.ErrInvalidName {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"roomID":      room.ID,
		"maxPlayers":  req.MaxPlayers,
		"lives":       req.LivesCount,
		"hasPassword": room.Password != "",
	})
}

// ListRoomsHandler handles GET /rooms.
func (h *Hub) ListRoomsHandler(c *gin.Context) {
	rooms := h.ListRooms()
	list := make([]game.RoomSummary, 0, len(rooms))
	for _, r := range rooms {
		list = append(list, r.Summary())
	}
	c.JSON(http.StatusOK, gin.H{"rooms": list})
}
