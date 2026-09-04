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

/** Draws the vector icon for `key` centred at (cx,cy) with radius `r`. */
export function drawItemIcon(ctx: CanvasRenderingContext2D, key: string, cx: number, cy: number, r: number): void {
  const def = itemDef(key);
  if (!def) return;
  ctx.save();
  ctx.translate(cx, cy);

  // Soft neon halo behind the chip.
  const halo = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.35);
  halo.addColorStop(0, hexA(def.color, 0.5));
  halo.addColorStop(0.6, hexA(def.color, 0.14));
  halo.addColorStop(1, hexA(def.color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
  ctx.fill();

  // Dark glossy "chip" the emblem sits on.
  const chip = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.05, 0, 0, r);
  chip.addColorStop(0, 'rgba(22,32,56,0.96)');
  chip.addColorStop(0.55, 'rgba(11,17,32,0.97)');
  chip.addColorStop(1, 'rgba(4,7,15,0.98)');
  ctx.fillStyle = chip;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.98, 0, Math.PI * 2);
  ctx.fill();

  // Neon rim (glowing ring + thin glass highlight on top).
  ctx.shadowColor = def.color;
  ctx.shadowBlur = r * 0.7;
  ctx.strokeStyle = def.color;
  ctx.lineWidth = r * 0.07;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hexA('#ffffff', 0.35);
  ctx.lineWidth = r * 0.025;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.9, Math.PI * 1.05, Math.PI * 2.05);
  ctx.stroke();

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

// --- shared helpers ----------------------------------------------------------

function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  const rr = (n >> 16) & 255;
  const gg = (n >> 8) & 255;
  const bb = n & 255;
  return `rgba(${rr},${gg},${bb},${alpha})`;
}

function specular(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const g = ctx.createRadialGradient(-rx * 0.4, -ry * 0.5, 0, 0, 0, Math.max(rx, ry) * 1.5);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Горящий мяч: раскалённый шар с языком пламени и бликом.
function flame(ctx: CanvasRenderingContext2D, r: number): void {
  // язык пламени (внешний)
  const fg = ctx.createLinearGradient(0, -r, 0, r * 0.5);
  fg.addColorStop(0, '#fff3b0');
  fg.addColorStop(0.45, '#ffc93d');
  fg.addColorStop(1, '#ff6a00');
  ctx.fillStyle = fg;
  ctx.shadowColor = '#ff8a00';
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.85);
  ctx.bezierCurveTo(r * 0.34, -r * 0.45, r * 0.44, -r * 0.12, r * 0.2, r * 0.16);
  ctx.bezierCurveTo(-r * 0.44, -r * 0.1, -r * 0.34, -r * 0.45, 0, -r * 0.85);
  ctx.fill();
  // внутреннее белое ядро пламени
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.56);
  ctx.bezierCurveTo(r * 0.18, -r * 0.32, r * 0.2, -r * 0.12, r * 0.08, r * 0.05);
  ctx.bezierCurveTo(-r * 0.2, -r * 0.12, -r * 0.18, -r * 0.32, 0, -r * 0.56);
  ctx.fill();
  // раскалённый шар
  const og = ctx.createRadialGradient(-r * 0.2, -r * 0.3, r * 0.04, 0, r * 0.16, r * 0.6);
  og.addColorStop(0, '#ffe9a8');
  og.addColorStop(0.4, '#ffb020');
  og.addColorStop(0.82, '#ff3d00');
  og.addColorStop(1, '#a91d0d');
  ctx.fillStyle = og;
  ctx.shadowColor = '#ff6a00';
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.arc(0, r * 0.28, r * 0.48, 0, Math.PI * 2);
  ctx.fill();
  specular(ctx, -r * 0.2, r * 0.14, r * 0.1, r * 0.14, -0.6);
}

// Ослепление: яркая звезда-вспышка с переменно-длинными лучами.
function burst(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = r * 0.45;
  ctx.fillStyle = '#fff6cf';
  ctx.strokeStyle = '#ffd98a';
  ctx.lineWidth = r * 0.03;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const long = i % 2 === 0;
    const len = long ? r * 0.92 : r * 0.66;
    const half = long ? r * 0.1 : r * 0.12;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy;
    const py = dx;
    ctx.beginPath();
    ctx.moveTo(dx * r * 0.16 + px * half * 0.5, dy * r * 0.16 + py * half * 0.5);
    ctx.lineTo(dx * len, dy * len);
    ctx.lineTo(dx * r * 0.16 - px * half * 0.5, dy * r * 0.16 - py * half * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // ядро
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.32);
  core.addColorStop(0, '#ffffff');
  core.addColorStop(0.7, '#fff9e0');
  core.addColorStop(1, '#ffefb0');
  ctx.fillStyle = core;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
}

// Кручёный: неоновая дуга-росчерк, заканчивающаяся светящимся мячом.
function swirl(ctx: CanvasRenderingContext2D, r: number): void {
  const sweep = (wide: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = wide;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.6, Math.PI * 0.12, Math.PI * 1.62);
    ctx.stroke();
  };
  ctx.shadowColor = '#1fb8ff';
  ctx.shadowBlur = r * 0.5;
  sweep(r * 0.16, '#0b6fff');
  ctx.shadowBlur = 0;
  sweep(r * 0.055, '#c6f1ff');
  // светящийся мяч в начале дуги
  const ex = Math.cos(Math.PI * 0.12) * r * 0.6;
  const ey = Math.sin(Math.PI * 0.12) * r * 0.6;
  const bg = ctx.createRadialGradient(ex - r * 0.1, ey - r * 0.12, r * 0.02, ex, ey, r * 0.2);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(0.5, '#5cdcff');
  bg.addColorStop(1, '#0b6fff');
  ctx.fillStyle = bg;
  ctx.shadowColor = '#4dd0ff';
  ctx.shadowBlur = r * 0.45;
  ctx.beginPath();
  ctx.arc(ex, ey, r * 0.17, 0, Math.PI * 2);
  ctx.fill();
}

// Защита: глянцевый металлический щит с неоновой галочкой.
function shieldIcon(ctx: CanvasRenderingContext2D, r: number): void {
  const sg = ctx.createLinearGradient(0, -r, 0, r);
  sg.addColorStop(0, '#ffffff');
  sg.addColorStop(0.28, '#e4ecf2');
  sg.addColorStop(0.7, '#9db0bf');
  sg.addColorStop(1, '#5f7485');
  ctx.fillStyle = sg;
  ctx.shadowColor = '#cfe7ff';
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.92);
  ctx.quadraticCurveTo(r * 0.92, -r * 0.48, r * 0.92, 0);
  ctx.quadraticCurveTo(r * 0.92, r * 0.56, 0, r * 0.95);
  ctx.quadraticCurveTo(-r * 0.92, r * 0.56, -r * 0.92, 0);
  ctx.quadraticCurveTo(-r * 0.92, -r * 0.48, 0, -r * 0.92);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = r * 0.05;
  ctx.strokeStyle = '#eaf4fb';
  ctx.stroke();
  ctx.lineWidth = r * 0.035;
  ctx.strokeStyle = '#40586a';
  ctx.stroke();
  // неоновая галочка «защищено»
  ctx.strokeStyle = '#2fe6ff';
  ctx.lineWidth = r * 0.14;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#2fe6ff';
  ctx.shadowBlur = r * 0.32;
  ctx.beginPath();
  ctx.moveTo(-r * 0.42, r * 0.04);
  ctx.lineTo(-r * 0.1, r * 0.34);
  ctx.lineTo(r * 0.44, -r * 0.28);
  ctx.stroke();
}

function snowflake(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.lineCap = 'round';
  const trace = (w: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(dx * r * 0.14, dy * r * 0.14);
      ctx.lineTo(dx * r * 0.86, dy * r * 0.86);
      ctx.stroke();
      const bx = dx * r * 0.56;
      const by = dy * r * 0.56;
      ctx.beginPath();
      ctx.moveTo(bx - dy * r * 0.2, by + dx * r * 0.2);
      ctx.lineTo(bx + dy * r * 0.2, by - dx * r * 0.2);
      ctx.stroke();
    }
  };
  ctx.shadowColor = '#66d0ff';
  ctx.shadowBlur = r * 0.4;
  trace(r * 0.14, 'rgba(125,220,255,0.5)');
  ctx.shadowBlur = 0;
  trace(r * 0.05, '#eafaff');
  // маленькие снежинки между лучами
  ctx.fillStyle = '#bff0ff';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r * 0.52, Math.sin(a) * r * 0.52, r * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
  // гексагональное ядро
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.2);
  cg.addColorStop(0, '#ffffff');
  cg.addColorStop(1, '#a8e6ff');
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

// Обманка: настоящий шар + «призрачный» зеркальный двойник.
function doubleBall(ctx: CanvasRenderingContext2D, r: number): void {
  // реальный шар
  const g = ctx.createRadialGradient(-r * 0.58, -r * 0.18, r * 0.03, -r * 0.42, 0, r * 0.42);
  g.addColorStop(0, '#f0e0ff');
  g.addColorStop(0.55, '#b06bff');
  g.addColorStop(1, '#64209b');
  ctx.fillStyle = g;
  ctx.shadowColor = '#c77dff';
  ctx.shadowBlur = r * 0.4;
  ctx.beginPath();
  ctx.arc(-r * 0.42, 0, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  specular(ctx, -r * 0.54, -r * 0.12, r * 0.1, r * 0.13, -0.5);
  // призрачный двойник (пунктирный контур)
  ctx.save();
  ctx.setLineDash([r * 0.11, r * 0.08]);
  ctx.strokeStyle = '#d18bff';
  ctx.lineWidth = r * 0.07;
  ctx.shadowColor = '#d18bff';
  ctx.shadowBlur = r * 0.35;
  ctx.beginPath();
  ctx.arc(r * 0.42, 0, r * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(209,139,255,0.16)';
  ctx.fill();
  ctx.restore();
  // зеркальная ось + точка-центр двойника
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = r * 0.03;
  ctx.beginPath();
  ctx.moveTo(-r * 0.06, 0);
  ctx.lineTo(r * 0.06, 0);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(r * 0.42, 0, r * 0.07, 0, Math.PI * 2);
  ctx.fill();
}

// Липучка: глянцевая капля + маленькая «прилипшая» капелька.
function droplet(ctx: CanvasRenderingContext2D, r: number): void {
  const g = ctx.createLinearGradient(0, -r * 0.9, 0, r * 0.9);
  g.addColorStop(0, '#e6ffa3');
  g.addColorStop(0.45, '#a4f74f');
  g.addColorStop(1, '#2f9e37');
  ctx.fillStyle = g;
  ctx.shadowColor = '#8dff54';
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.86);
  ctx.bezierCurveTo(r * 0.84, r * 0.12, r * 0.5, r * 0.9, 0, r * 0.9);
  ctx.bezierCurveTo(-r * 0.5, r * 0.9, -r * 0.84, r * 0.12, 0, -r * 0.86);
  ctx.fill();
  ctx.shadowBlur = 0;
  specular(ctx, -r * 0.28, r * 0.08, r * 0.16, r * 0.18, -0.6);
  // маленькая прилипшая капля
  const sx = r * 0.52;
  const sy = r * 0.4;
  const sr = r * 0.2;
  const sg = ctx.createLinearGradient(sx, sy - sr, sx, sy + sr);
  sg.addColorStop(0, '#e8ffb4');
  sg.addColorStop(1, '#3aa63f');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.moveTo(sx, sy - sr);
  ctx.bezierCurveTo(sx + sr * 1.1, sy - sr * 0.1, sx + sr * 0.6, sy + sr, sx, sy + sr);
  ctx.bezierCurveTo(sx - sr * 0.6, sy + sr, sx - sr * 1.1, sy - sr * 0.1, sx, sy - sr);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(sx - sr * 0.3, sy - sr * 0.25, sr * 0.28, 0, Math.PI * 2);
  ctx.fill();
}

// Связывание: привязанный светящийся мяч внутри верёвочной петли-лассо.
function ropeKnot(ctx: CanvasRenderingContext2D, r: number): void {
  // светящийся «привязанный» мяч
  const bx = r * 0.3;
  const by = r * 0.28;
  const br = r * 0.2;
  const bg = ctx.createRadialGradient(bx - br * 0.4, by - br * 0.4, br * 0.08, bx, by, br * 1.2);
  bg.addColorStop(0, '#ffedcb');
  bg.addColorStop(0.55, '#d8a06a');
  bg.addColorStop(1, '#5f3512');
  ctx.fillStyle = bg;
  ctx.shadowColor = '#ffc77a';
  ctx.shadowBlur = r * 0.4;
  ctx.beginPath();
  ctx.arc(bx, by, br, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  specular(ctx, bx - br * 0.35, by - br * 0.35, br * 0.3, br * 0.22, -0.6);
  // верёвочная петля (тёмная основа + светлый блик)
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#6e4520';
  ctx.lineWidth = r * 0.13;
  ctx.beginPath();
  ctx.ellipse(-r * 0.06, -r * 0.02, r * 0.74, r * 0.6, 0.4, Math.PI * 1.05, Math.PI * 3.55);
  ctx.stroke();
  ctx.strokeStyle = '#e2b376';
  ctx.lineWidth = r * 0.05;
  ctx.shadowColor = '#f0c488';
  ctx.shadowBlur = r * 0.18;
  ctx.beginPath();
  ctx.ellipse(-r * 0.06, -r * 0.02, r * 0.74, r * 0.6, 0.4, Math.PI * 1.05, Math.PI * 3.55);
  ctx.stroke();
}

// Режим тряски: неоновая сейсмограмма-«землетрясение».
function volcano(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // плашка-основание
  const base = ctx.createLinearGradient(0, 0, 0, r);
  base.addColorStop(0, '#ffcf70');
  base.addColorStop(1, '#e0492b');
  ctx.fillStyle = base;
  const rx = -r * 0.7;
  const ry = r * 0.42;
  const rw = r * 1.4;
  const rh = r * 0.22;
  const rad = r * 0.11;
  ctx.beginPath();
  ctx.moveTo(rx + rad, ry);
  ctx.lineTo(rx + rw - rad, ry);
  ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rad);
  ctx.lineTo(rx + rw, ry + rh - rad);
  ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rad, ry + rh);
  ctx.lineTo(rx + rad, ry + rh);
  ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rad);
  ctx.lineTo(rx, ry + rad);
  ctx.quadraticCurveTo(rx, ry, rx + rad, ry);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#7a2210';
  ctx.lineWidth = r * 0.025;
  ctx.stroke();
  // трясущаяся ломаная
  const trace = (w: number, color: string, blur: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.beginPath();
    ctx.moveTo(-r * 0.56, r * 0.28);
    for (let i = 1; i <= 8; i++) {
      const nx = -r * 0.56 + i * (r * 1.12 / 8);
      const ny = r * 0.28 - (i % 2 ? r * 0.52 : r * 0.02);
      ctx.lineTo(nx, ny);
    }
    ctx.stroke();
  };
  trace(r * 0.1, '#ff9d45', r * 0.5);
  ctx.shadowBlur = 0;
  trace(r * 0.04, '#fff3cf', 0);
  // искры тряски по краям
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(-r * 0.78, -r * 0.05, r * 0.05, 0, Math.PI * 2);
  ctx.arc(r * 0.78, -r * 0.12, r * 0.045, 0, Math.PI * 2);
  ctx.fill();
}
