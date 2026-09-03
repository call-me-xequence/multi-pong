// types.ts — network message shapes shared between client and server.

export interface SnapshotBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface SnapshotPlayer {
  id: string;
  name: string;
  index: number;
  angle: number;
  lives: number;
  isAlive: boolean;
  isHost: boolean;
  lastSeq?: number; // last input sequence processed by the server
}

export type GameState = 'waiting' | 'playing' | 'ended';

export interface Snapshot {
  type: 'snapshot';
  t: number; // server time, ms
  roomID: string;
  you: string;
  state: GameState;
  host: string;
  winner?: string;
  sides: number;
  radius: number;
  chamfer: number;
  paddleHalf: number;
  paddleSpeed: number;
  ballRadius: number;
  ballSpeed: number;
  respawnIn?: number; // seconds until the next ball spawns (0 = none pending)
  lives?: number; // room lives setting (for the host UI)
  ballAccel?: boolean;
  addBallTime?: number;
  players: SnapshotPlayer[];
  balls: SnapshotBall[];
}

export interface WelcomeMessage {
  type: 'welcome';
  you: string;
  roomID: string;
  host: string;
  state: GameState;
  maxPlayers: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface PongMessage {
  type: 'pong';
  c: number; // client time that was echoed back
  t: number; // server time, ms
}

export interface KickedMessage {
  type: 'kicked';
}

export type ServerMessage = Snapshot | WelcomeMessage | ErrorMessage | PongMessage | KickedMessage;

export interface ClientMoveMessage {
  action: 'move';
  dir: number; // +1, -1 or 0
  seq?: number; // input sequence number, for reconciliation
}

export interface ClientStartMessage {
  action: 'start';
}

export interface ClientPingMessage {
  action: 'ping';
  c: number;
}

export interface ClientKickMessage {
  action: 'kick';
  target: string;
}

export interface ClientConfigMessage {
  action: 'config';
  lives: number;
  ballAccel: boolean;
  addBallTime: number;
}

export type ClientMessage =
  | ClientMoveMessage
  | ClientStartMessage
  | ClientPingMessage
  | ClientKickMessage
  | ClientConfigMessage;

export interface RoomInfo {
  roomID: string;
  players: number;
  maxPlayers: number;
  state: string;
  hasPassword: boolean;
}
