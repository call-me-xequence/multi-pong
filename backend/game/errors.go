package game

import "errors"

var (
	ErrGameStarted      = errors.New("game already started")
	ErrRoomFull         = errors.New("room is full")
	ErrDuplicatePlayer  = errors.New("player already in room")
	ErrNotHost          = errors.New("only the host can do that")
	ErrNotEnoughPlayers = errors.New("not enough players to start")
	ErrRoomNotFound     = errors.New("room not found")
)
