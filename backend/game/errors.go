package game

import "errors"

var (
	ErrGameStarted      = errors.New("game already started")
	ErrRoomFull         = errors.New("room is full")
	ErrDuplicatePlayer  = errors.New("player already in room")
	ErrNotHost          = errors.New("only the host can do that")
	ErrNotEnoughPlayers = errors.New("not enough players to start")
	ErrRoomNotFound     = errors.New("room not found")
	ErrRoomExists       = errors.New("room name already taken")
	ErrWrongPassword    = errors.New("wrong password")
	ErrInvalidName      = errors.New("room name is required")
	ErrPlayerNotFound   = errors.New("player not found")
	ErrCannotKickSelf   = errors.New("cannot kick yourself")
	ErrNoItem           = errors.New("no item to use")
	ErrCannotUseItem    = errors.New("cannot use items right now")
)
