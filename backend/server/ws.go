package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"neonpong/game"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Allow any origin so friends can connect from a browser on another machine.
	CheckOrigin: func(r *http.Request) bool { return true },
}

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 50 * time.Second
)

// WSHandler handles GET /ws?roomID=X&playerName=Y.
func (h *Hub) WSHandler(c *gin.Context) {
	roomID := c.Query("roomID")
	playerName := c.Query("playerName")
	password := c.Query("password")

	if roomID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "roomID is required"})
		return
	}
	if playerName == "" {
		playerName = "Player"
	}
	if len([]rune(playerName)) > 16 {
		playerName = string([]rune(playerName)[:16])
	}

	// Upgrade first so we can report errors as structured messages.
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	room, ok := h.GetRoom(roomID)
	if !ok {
		_ = conn.WriteJSON(map[string]interface{}{"type": "error", "message": "room not found"})
		_ = conn.Close()
		return
	}
	if !room.CheckPassword(password) {
		_ = conn.WriteJSON(map[string]interface{}{"type": "error", "message": "wrong password"})
		_ = conn.Close()
		return
	}

	playerID := randomID()
	player, err := room.AddPlayer(playerID, playerName)
	if err != nil {
		_ = conn.WriteJSON(map[string]interface{}{"type": "error", "message": err.Error()})
		_ = conn.Close()
		return
	}

	// Send the welcome message before snapshots start flowing.
	queueJSON(player, map[string]interface{}{
		"type":       "welcome",
		"you":        playerID,
		"roomID":     roomID,
		"host":       room.HostID,
		"state":      room.State,
		"maxPlayers": room.MaxPlayers,
	})

	// Writer goroutine: the single place that writes to the socket.
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		defer func() {
			room.RemovePlayer(playerID)
			_ = conn.Close()
		}()

		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		conn.SetPongHandler(func(string) error {
			_ = conn.SetReadDeadline(time.Now().Add(pongWait))
			return nil
		})

		for {
			select {
			case <-done:
				return
			case <-player.Kick:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"kicked"}`))
				return
			case msg := <-player.Send:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					return
				}
			case <-ticker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	// Reader loop: parses incoming client commands.
	for {
		var msg struct {
			Action      string  `json:"action"`
			Dir         int     `json:"dir"`
			Seq         uint32  `json:"seq"`
			Lag         float64 `json:"lag"`
			C           float64 `json:"c"`
			Target      string  `json:"target"`
			Lives       int     `json:"lives"`
			BallAccel   bool    `json:"ballAccel"`
			AddBallTime int     `json:"addBallTime"`
			Items       bool    `json:"items"`
		}
		if err := conn.ReadJSON(&msg); err != nil {
			break
		}
		switch msg.Action {
		case "move":
			room.HandleInput(playerID, msg.Dir, msg.Seq, msg.Lag)
		case "start":
			if err := room.Start(playerID); err != nil {
				queueJSON(player, map[string]interface{}{
					"type": "error", "message": err.Error(),
				})
			}
		case "kick":
			target, err := room.Kick(playerID, msg.Target)
			if err != nil {
				queueJSON(player, map[string]interface{}{
					"type": "error", "message": err.Error(),
				})
			} else if target != nil {
				close(target.Kick)
			}
		case "config":
			if err := room.UpdateConfig(playerID, msg.Lives, msg.BallAccel, msg.AddBallTime, msg.Items); err != nil {
				queueJSON(player, map[string]interface{}{
					"type": "error", "message": err.Error(),
				})
			}
		case "use_item":
			if err := room.UseItem(playerID); err != nil {
				queueJSON(player, map[string]interface{}{
					"type": "error", "message": err.Error(),
				})
			}
		case "ping":
			queueJSON(player, map[string]interface{}{
				"type": "pong",
				"c":    msg.C,
				"t":    time.Now().UnixMilli(),
			})
		}
	}

	close(done)
	room.RemovePlayer(playerID)
	_ = conn.Close()
}

// queueJSON marshals v and enqueues it for delivery over the player's socket.
func queueJSON(player *game.Player, v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case player.Send <- data:
	default: // slow client: drop
	}
}
