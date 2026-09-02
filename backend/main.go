package main

import (
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"neonpong/server"
)

func main() {
	h := server.NewHub()

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(corsMiddleware())

	// REST API
	r.POST("/create-room", h.CreateRoomHandler)
	r.GET("/rooms", h.ListRoomsHandler)
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	// WebSocket
	r.GET("/ws", h.WSHandler)

	// Optional local static serving (STATIC_DIR env), used outside nginx.
	if dir := os.Getenv("STATIC_DIR"); dir != "" {
		r.NoRoute(func(c *gin.Context) {
			if c.Request.Method != http.MethodGet {
				c.Status(http.StatusNotFound)
				return
			}
			p := strings.TrimPrefix(path.Clean("/"+c.Request.URL.Path), "/")
			full := filepath.Join(dir, filepath.FromSlash(p))
			if info, err := os.Stat(full); err == nil && !info.IsDir() {
				c.File(full)
				return
			}
			// SPA fallback
			c.File(filepath.Join(dir, "index.html"))
		})
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("Neon Pong server listening on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
