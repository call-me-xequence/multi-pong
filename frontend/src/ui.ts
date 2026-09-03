// ui.ts — DOM helpers shared across screens.

import type { Snapshot, RoomInfo } from './types.js';
import { playerColor } from './renderer.js';
import { drawItemIcon, itemDef } from './items.js';

export function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

export type ScreenName = 'menu' | 'create' | 'join' | 'lobby' | 'game';

const SCREENS: ScreenName[] = ['menu', 'create', 'join', 'lobby', 'game'];

export function showScreen(name: ScreenName): void {
  SCREENS.forEach((s) => {
    $('screen-' + s).classList.toggle('active', s === name);
  });
}

export function showMenuError(msg: string | null): void {
  const box = $('menu-error');
  box.textContent = msg ?? '';
  box.classList.toggle('hidden', !msg);
}

export function showFormError(form: 'create' | 'join', msg: string | null): void {
  const box = $(form + '-error');
  box.textContent = msg ?? '';
  box.classList.toggle('hidden', !msg);
}

function stateLabel(state: string): string {
  return state === 'waiting' ? 'ожидание' : state === 'playing' ? 'игра' : 'завершена';
}

export function renderRoomList(
  rooms: RoomInfo[],
  filter: string,
  stateFilter: string,
  onJoin: (roomID: string) => void,
): void {
  const list = $('room-list');
  list.innerHTML = '';
  const f = filter.trim().toLowerCase();
  const shown = rooms.filter((r) => {
    if (f && !r.roomID.toLowerCase().includes(f)) return false;
    if (stateFilter !== 'all' && r.state !== stateFilter) return false;
    return true;
  });

  if (shown.length === 0) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = rooms.length === 0 ? 'Комнат пока нет' : 'Ничего не найдено';
    list.appendChild(li);
    return;
  }

  for (const r of shown) {
    const li = document.createElement('li');
    li.className = 'room-row';
    li.tabIndex = 0;

    const info = document.createElement('div');
    info.className = 'room-info';

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = r.roomID + (r.hasPassword ? ' 🔒' : '');

    const meta = document.createElement('span');
    meta.className = 'hint';
    meta.textContent = `${r.players}/${r.maxPlayers} · ${stateLabel(r.state)}`;

    info.append(name, meta);

    const join = document.createElement('button');
    join.className = 'btn btn-sm btn-join';
    join.type = 'button';
    join.textContent = 'Подключиться';
    join.addEventListener('click', (e) => {
      e.stopPropagation();
      onJoin(r.roomID);
    });

    li.append(info, join);
    li.addEventListener('click', () => onJoin(r.roomID));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onJoin(r.roomID);
      }
    });
    list.appendChild(li);
  }
}

function renderPlayers(
  container: HTMLElement,
  snap: Snapshot,
  isHost: boolean,
  onKick: (id: string) => void,
): void {
  container.innerHTML = '';
  snap.players.forEach((p, i) => {
    const li = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = playerColor(i);
    dot.style.color = playerColor(i);

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent =
      p.name + (p.isHost ? ' ★' : '') + (!p.isAlive ? ' · наблюдатель' : '');

    li.append(dot, name);

    if (isHost && p.id !== snap.you) {
      const kick = document.createElement('button');
      kick.className = 'btn btn-sm btn-kick';
      kick.type = 'button';
      kick.textContent = 'Выгнать';
      kick.addEventListener('click', () => onKick(p.id));
      li.appendChild(kick);
    }

    container.appendChild(li);
  });
}

export function renderLobby(snap: Snapshot, link: string, onKick: (id: string) => void): void {
  $('lobby-room-id').textContent = snap.roomID;
  ($('lobby-link') as HTMLInputElement).value = link;

  const isHost = snap.players.some((p) => p.id === snap.you && p.isHost);
  renderPlayers($('lobby-players'), snap, isHost, onKick);

  $('btn-start').classList.toggle('hidden', !isHost);
  $('lobby-status').textContent = isHost
    ? 'Вы создатель — нажмите «Начать игру», когда все готовы.'
    : 'Ожидание запуска создателем...';
}

export function renderGameOverPlayers(snap: Snapshot, onKick: (id: string) => void): void {
  const isHost = snap.players.some((p) => p.id === snap.you && p.isHost);
  renderPlayers($('game-over-kick-list'), snap, isHost, onKick);
}

export function renderHUD(snap: Snapshot, elapsedSec: number): void {
  const wrap = $('hud-players');
  wrap.innerHTML = '';
  for (const p of snap.players) {
    const item = document.createElement('div');
    item.className = 'hud-player' + (p.isAlive ? '' : ' dead');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = playerColor(Math.max(0, p.index));
    dot.style.color = playerColor(Math.max(0, p.index));

    const name = document.createElement('span');
    name.textContent = p.name;

    const lives = document.createElement('span');
    lives.className = 'lives';
    lives.textContent = p.isAlive ? '♥'.repeat(Math.max(0, p.lives)) : '✕';

    item.append(dot, name, lives);
    wrap.appendChild(item);
  }

  const m = Math.floor(elapsedSec / 60);
  const s = Math.floor(elapsedSec % 60);
  $('hud-time').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

export function showToast(msg: string, ms = 3000): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  window.setTimeout(() => t.classList.add('hidden'), ms);
}

/** Updates the item slot box (right of the field) with the held item of me. */
export function updateItemSlot(snap: Snapshot): void {
  const slot = $('item-slot');
  const cv = $('item-slot-canvas') as HTMLCanvasElement;
  const hint = $('item-slot-hint');
  slot.classList.toggle('hidden', !snap.items);
  if (!snap.items) return;

  const me = snap.players.find((p) => p.id === snap.you);
  // Spectators can't use items, so don't show them a stale held item.
  const key = me && me.isAlive ? me.item || '' : '';
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (key) {
      drawItemIcon(ctx, key, cv.width / 2, cv.height / 2, cv.width * 0.34);
    }
  }
  const def = itemDef(key);
  hint.textContent = key ? (def ? def.name : 'Предмет') : '—';
  hint.classList.toggle('hidden', !key);
  if (key) slot.classList.add('flash');
  else slot.classList.remove('flash');
}
