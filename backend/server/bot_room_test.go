package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"neonpong/game"
)

// vsBotRoomMsg is like wireMsg but also exposes the per-player isBot flag.
type vsBotRoomMsg struct {
	Type    string `json:"type"`
	State   string `json:"state"`
	Players []struct {
		ID    string `json:"id"`
		IsBot bool   `json:"isBot"`
	} `json:"players"`
}

func readUntilType(t *testing.T, conn *websocket.Conn, wantType string) *vsBotRoomMsg {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			continue
		}
		var m vsBotRoomMsg
		if json.Unmarshal(data, &m) != nil || m.Type != wantType {
			continue
		}
		return &m
	}
	t.Fatal("message of type " + wantType + " not received in time")
	return nil
}

func TestVsBotRoomFlow(t *testing.T) {
	h := NewHub()
	srv := newTestServer(h)
	defer srv.Close()

	// 1. Create a bot match (empty name -> server picks a private name).
	resp, err := http.Post(srv.URL+"/create-room", "application/json",
		strings.NewReader(`{"name":"","vsBot":true,"bots":1,"items":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var cr struct {
		RoomID string `json:"roomID"`
		VsBot  bool   `json:"vsBot"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if cr.RoomID == "" || !cr.VsBot {
		t.Fatalf("bad create response: %+v", cr)
	}

	// 2. Bot matches must not appear in the public room list.
	lr, err := http.Get(srv.URL + "/rooms")
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Rooms []game.RoomSummary `json:"rooms"`
	}
	if err := json.NewDecoder(lr.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	lr.Body.Close()
	for _, r := range list.Rooms {
		if r.RoomID == cr.RoomID {
			t.Fatal("bot room leaked into the public room list")
		}
	}

	// 3. The human connects; the bot is auto-added behind them.
	c1 := dialWS(t, srv.URL, cr.RoomID, "Me")
	defer c1.Close()
	readUntilType(t, c1, "welcome")

	if err := c1.WriteJSON(map[string]interface{}{"action": "start"}); err != nil {
		t.Fatal(err)
	}
	// The host's start should be accepted and a playing snapshot with 2 players
	// (one of them a bot) must arrive.
	got := readUntilType(t, c1, "snapshot")
	if got.State != game.StatePlaying {
		t.Fatalf("expected playing, got %s", got.State)
	}
	if len(got.Players) != 2 {
		t.Fatalf("expected 2 players (human + bot), got %d", len(got.Players))
	}
	botCount := 0
	for _, p := range got.Players {
		if p.IsBot {
			botCount++
		}
	}
	if botCount != 1 {
		t.Fatalf("expected exactly one bot, got %d", botCount)
	}
}
