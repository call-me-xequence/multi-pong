package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"neonpong/game"
)

type wireMsg struct {
	Type    string `json:"type"`
	You     string `json:"you"`
	Host    string `json:"host"`
	State   string `json:"state"`
	Sides   int    `json:"sides"`
	Players []struct {
		ID    string  `json:"id"`
		Angle float64 `json:"angle"`
	} `json:"players"`
	Balls []struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	} `json:"balls"`
}

func newTestServer(h *Hub) *httptest.Server {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/create-room", h.CreateRoomHandler)
	r.GET("/rooms", h.ListRoomsHandler)
	r.GET("/ws", h.WSHandler)
	return httptest.NewServer(r)
}

func dialWS(t *testing.T, baseURL, roomID, name string) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(baseURL, "http") + "/ws?roomID=" + roomID + "&playerName=" + name
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", name, err)
	}
	return conn
}

func readUntil(t *testing.T, conn *websocket.Conn, cond func(*wireMsg) bool) *wireMsg {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			continue
		}
		var m wireMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if cond(&m) {
			return &m
		}
	}
	t.Fatal("condition not met in time")
	return nil
}

func TestCreateRoomAndWebSocketFlow(t *testing.T) {
	h := NewHub()
	srv := newTestServer(h)
	defer srv.Close()

	// 1. Create a 2-player room (auto-starts when full).
	resp, err := http.Post(srv.URL+"/create-room", "application/json",
		strings.NewReader(`{"maxPlayers":2,"livesCount":1,"ballAccel":false,"addBallTime":0}`))
	if err != nil {
		t.Fatal(err)
	}
	var cr struct {
		RoomID string `json:"roomID"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if cr.RoomID == "" {
		t.Fatal("no roomID returned")
	}

	// 2. Two players join. The second one fills the room and starts the game.
	c1 := dialWS(t, srv.URL, cr.RoomID, "P1")
	defer c1.Close()
	w1 := readUntil(t, c1, func(m *wireMsg) bool { return m.Type == "welcome" })
	if w1.You == "" {
		t.Fatal("player 1 got no ID")
	}

	c2 := dialWS(t, srv.URL, cr.RoomID, "P2")
	defer c2.Close()
	readUntil(t, c2, func(m *wireMsg) bool { return m.Type == "welcome" })

	// 3. Both players should see a playing snapshot with 2 players and a ball.
	snap := readUntil(t, c1, func(m *wireMsg) bool {
		return m.Type == "snapshot" && m.State == game.StatePlaying
	})
	if snap.Sides != 4 {
		t.Fatalf("expected 4-sided arena for 2 players, got %d", snap.Sides)
	}
	if len(snap.Players) != 2 {
		t.Fatalf("expected 2 players, got %d", len(snap.Players))
	}
	if len(snap.Balls) == 0 {
		t.Fatal("expected at least one ball")
	}

	// 4. Send a move and make sure it doesn't error the connection.
	if err := c1.WriteJSON(map[string]interface{}{"action": "move", "dir": 1}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, c1, func(m *wireMsg) bool {
		return m.Type == "snapshot" && len(m.Players) == 2
	})

	// 5. /rooms should list our room.
	resp2, err := http.Get(srv.URL + "/rooms")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var list struct {
		Rooms []struct {
			RoomID string `json:"roomID"`
			State  string `json:"state"`
		} `json:"rooms"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range list.Rooms {
		if r.RoomID == cr.RoomID {
			found = true
			if r.State != game.StatePlaying {
				t.Fatalf("room state = %s, want playing", r.State)
			}
		}
	}
	if !found {
		t.Fatal("room missing from /rooms")
	}
}
