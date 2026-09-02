// ui.ts — small DOM helpers shared across screens.

import type { Snapshot } from './types.js';
import { playerColor } from './renderer.js';

export function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

export function showScreen(name: 'menu' | 'lobby' | 'game'): void {
  ['menu', 'lobby', 'game'].forEach((s) => {
    $('screen-' + s).classList.toggle('active', s === name);
  });
}

export function showMenuError(msg: string | null): void {
  const box = $('menu-error');
  box.textContent = msg ?? '';
  box.classList.toggle('hidden', !msg);
}

export function renderLobby(snap: Snapshot, link: string): void {
  $('lobby-room-id').textContent = snap.roomID;
  ($('lobby-link') as HTMLInputElement).value = link;

  const list = $('lobby-players');
  list.innerHTML = '';
  snap.players.forEach((p, i) => {
    const li = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = playerColor(i);
    dot.style.color = playerColor(i);

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (p.isHost ? ' ★' : '');

    li.append(dot, name);
    list.appendChild(li);
  });

  const isHost = snap.players.some((p) => p.id === snap.you && p.isHost);
  $('btn-start').classList.toggle('hidden', !isHost);
  $('lobby-status').textContent = isHost
    ? 'Вы создатель — нажмите «Начать игру», когда все готовы.'
    : 'Ожидание запуска создателем...';
}

export function renderHUD(snap: Snapshot, elapsedSec: number): void {
  const wrap = $('hud-players');
  wrap.innerHTML = '';
  for (const p of snap.players) {
    const item = document.createElement('div');
    item.className = 'hud-player' + (p.isAlive ? '' : ' dead');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = playerColor(p.index);
    dot.style.color = playerColor(p.index);

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
