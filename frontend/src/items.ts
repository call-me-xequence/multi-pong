// items.ts — power-up catalog + canvas vector icons (drawn in the game style).

export interface ItemDef {
  key: string;
  name: string;
  desc: string;
  color: string; // main accent
  dark: string; // dark shade for depth
}

export const ITEMS: ItemDef[] = [
  { key: 'fire', name: 'Горящий мяч', desc: '+50% к скорости мяча', color: '#ffb020', dark: '#ff3d00' },
  { key: 'flash', name: 'Ослепление', desc: 'Вспышка ослепляет всех соперников', color: '#ffffff', dark: '#ffe9a8' },
  { key: 'curve', name: 'Кручёный', desc: 'Мяч летит по дуге', color: '#4dd0ff', dark: '#0b6fff' },
  { key: 'shield', name: 'Защита', desc: 'Ворота непробиваемы 8 сек', color: '#e8eef2', dark: '#8fa6b5' },
  { key: 'freeze', name: 'Заморозка', desc: 'Морозит случайного соперника', color: '#aee6ff', dark: '#4fc3f7' },
  { key: 'fake', name: 'Обманка', desc: 'Два зеркальных мяча', color: '#d18bff', dark: '#8e24aa' },
  { key: 'sticky', name: 'Липучка', desc: 'Мяч липнет к поверхностям', color: '#a9ff4d', dark: '#3fa72f' },
  { key: 'tether', name: 'Связывание', desc: 'Привязывает мяч к каретке', color: '#d8a06a', dark: '#8a5a2b' },
  { key: 'shake', name: 'Режим тряски', desc: 'Тряска экрана у всех', color: '#ff8a4d', dark: '#c0392b' },
];

const BY_KEY = new Map<string, ItemDef>();
for (const it of ITEMS) BY_KEY.set(it.key, it);

export function itemDef(key?: string): ItemDef | null {
  if (!key) return null;
  return BY_KEY.get(key) || null;
}

/** Draws the vector icon for `key` centered at (cx,cy) with radius `r`. */
export function drawItemIcon(ctx: CanvasRenderingContext2D, key: string, cx: number, cy: number, r: number): void {
  const def = itemDef(key);
  if (!def) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = def.color;
  ctx.shadowBlur = r * 0.8;
  ctx.lineJoin = 'round';

  switch (key) {
    case 'fire':
      flame(ctx, r);
      break;
    case 'flash':
      burst(ctx, r);
      break;
    case 'curve':
      swirl(ctx, r);
      break;
    case 'shield':
      shieldIcon(ctx, r);
      break;
    case 'freeze':
      snowflake(ctx, r);
      break;
    case 'fake':
      doubleBall(ctx, r);
      break;
    case 'sticky':
      droplet(ctx, r);
      break;
    case 'tether':
      ropeKnot(ctx, r);
      break;
    case 'shake':
      volcano(ctx, r);
      break;
  }
  ctx.restore();
}

function flame(ctx: CanvasRenderingContext2D, r: number): void {
  const g = ctx.createLinearGradient(0, r, 0, -r);
  g.addColorStop(0, '#ff3d00');
  g.addColorStop(0.55, '#ff9100');
  g.addColorStop(1, '#ffea00');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.bezierCurveTo(r * 0.8, -r * 0.15, r * 0.65, r * 0.55, 0, r);
  ctx.bezierCurveTo(-r * 0.65, r * 0.55, -r * 0.8, -r * 0.15, 0, -r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.45);
  ctx.bezierCurveTo(r * 0.35, -r * 0.05, r * 0.22, r * 0.3, 0, r * 0.45);
  ctx.bezierCurveTo(-r * 0.22, r * 0.3, -r * 0.35, -r * 0.05, 0, -r * 0.45);
  ctx.fill();
}

function burst(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffe9a8';
  ctx.lineWidth = r * 0.14;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
    ctx.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
}

function swirl(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.strokeStyle = '#0b6fff';
  ctx.lineWidth = r * 0.22;
  ctx.beginPath();
  for (let i = 0; i < 40; i++) {
    const t = i / 40;
    const a = t * Math.PI * 3.4;
    const rad = r * (0.25 + 0.75 * t);
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#4dd0ff';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
}

function shieldIcon(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.fillStyle = '#dfe7ec';
  ctx.strokeStyle = '#8fa6b5';
  ctx.lineWidth = r * 0.16;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(r, -r * 0.55, r, 0);
  ctx.quadraticCurveTo(r, r * 0.6, 0, r);
  ctx.quadraticCurveTo(-r, r * 0.6, -r, 0);
  ctx.quadraticCurveTo(-r, -r * 0.55, 0, -r);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#6e8796';
  ctx.lineWidth = r * 0.18;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.7);
  ctx.lineTo(0, r * 0.75);
  ctx.moveTo(-r * 0.62, 0.0);
  ctx.lineTo(r * 0.62, 0);
  ctx.stroke();
}

function snowflake(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.strokeStyle = '#7fd8ff';
  ctx.lineWidth = r * 0.18;
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(dx * r * 0.2, dy * r * 0.2);
    ctx.lineTo(dx * r, dy * r);
    ctx.stroke();
    // little branches
    const bx = dx * r * 0.7;
    const by = dy * r * 0.7;
    ctx.beginPath();
    ctx.moveTo(bx - dy * r * 0.22, by + dx * r * 0.22);
    ctx.lineTo(bx + dy * r * 0.22, by - dx * r * 0.22);
    ctx.stroke();
  }
  ctx.fillStyle = '#d7f2ff';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

function doubleBall(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.fillStyle = '#b06bff';
  ctx.strokeStyle = '#d18bff';
  ctx.lineWidth = r * 0.1;
  ctx.beginPath();
  ctx.arc(-r * 0.5, 0, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(r * 0.5, 0, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(r * 0.5, -r * 0.15, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

function droplet(ctx: CanvasRenderingContext2D, r: number): void {
  const g = ctx.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, '#c6ff6b');
  g.addColorStop(1, '#2e9e35');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.bezierCurveTo(r * 0.95, r * 0.2, r * 0.6, r, 0, r);
  ctx.bezierCurveTo(-r * 0.6, r, -r * 0.95, r * 0.2, 0, -r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.arc(-r * 0.3, r * 0.25, r * 0.24, 0, Math.PI * 2);
  ctx.fill();
}

function ropeKnot(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.strokeStyle = '#8a5a2b';
  ctx.lineWidth = r * 0.2;
  ctx.lineCap = 'round';
  // crossing rope
  ctx.beginPath();
  ctx.moveTo(-r, -r * 0.6);
  ctx.quadraticCurveTo(0, r * 0.1, r, -r * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-r, r * 0.6);
  ctx.quadraticCurveTo(0, -r * 0.1, r, r * 0.6);
  ctx.stroke();
  // knot centre
  ctx.strokeStyle = '#d8a06a';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
  ctx.stroke();
}

function volcano(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.fillStyle = '#7b4a2b';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.45);
  ctx.lineTo(r * 0.85, r);
  ctx.lineTo(-r * 0.85, r);
  ctx.closePath();
  ctx.fill();
  const g = ctx.createLinearGradient(0, -r * 0.5, 0, r);
  g.addColorStop(0, '#ffcc33');
  g.addColorStop(1, '#e6482f');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.45);
  ctx.quadraticCurveTo(r * 0.2, r * 0.2, 0, r * 0.5);
  ctx.quadraticCurveTo(-r * 0.2, r * 0.2, 0, -r * 0.45);
  ctx.fill();
}
