// geometry.ts — mirrors the server geometry package so the client can predict
// physics locally with the exact same arena shape.

export interface Pt {
  x: number;
  y: number;
}

export interface Seg {
  a: Pt;
  b: Pt;
}

export const PI = Math.PI;

export function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}
export function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y };
}
export function mul(a: Pt, s: number): Pt {
  return { x: a.x * s, y: a.y * s };
}
export function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}
export function len(a: Pt): number {
  return Math.hypot(a.x, a.y);
}
export function norm(a: Pt): Pt {
  const l = len(a);
  if (l === 0) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}
export function perp(a: Pt): Pt {
  return { x: -a.y, y: a.x };
}

/** Vertices of a regular N-gon, first vertex at top, counter-clockwise. */
export function generatePolygon(sides: number, radius: number): Pt[] {
  if (sides < 3) sides = 3;
  const out: Pt[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = -PI / 2 + (i * 2 * PI) / sides;
    out.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return out;
}

/**
 * Cuts every corner with a straight line at distance `r` from the vertex.
 * Returns 2*sides ordered points; even segments are faces, odd are chamfers.
 */
export function chamferVertices(vertices: Pt[], r: number): Pt[] {
  const n = vertices.length;
  if (n < 3) return vertices.slice();

  const a: Pt[] = new Array(n);
  const b: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n];
    const cur = vertices[i];
    const next = vertices[(i + 1) % n];
    a[i] = pointAlong(cur, prev, r);
    b[i] = pointAlong(cur, next, r);
  }

  const out: Pt[] = [b[0]];
  for (let i = 1; i < n; i++) {
    out.push(a[i], b[i]);
  }
  out.push(a[0]);
  return out;
}

function pointAlong(from: Pt, to: Pt, dist: number): Pt {
  const d = sub(to, from);
  const l = len(d);
  if (l === 0) return { x: from.x, y: from.y };
  return add(from, mul(d, dist / l));
}

/** World-space angle from the polygon center to the middle of face `face`. */
export function faceMidAngle(sides: number, face: number): number {
  return -PI / 2 + (face + 0.5) * ((2 * PI) / sides);
}

export function closestPointOnSegment(p: Pt, s: Seg): Pt {
  const ab = sub(s.b, s.a);
  const ap = sub(p, s.a);
  const lenSq = dot(ab, ab);
  let t = 0;
  if (lenSq > 0) {
    t = dot(ap, ab) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  return add(s.a, mul(ab, t));
}

/** Build the full wall list (2*N segments) for a chamfered arena. */
export function buildWalls(sides: number, radius: number, chamfer: number): Seg[] {
  const v = generatePolygon(sides, radius);
  const c = chamferVertices(v, chamfer);
  const walls: Seg[] = [];
  for (let i = 0; i < c.length; i++) {
    walls.push({ a: c[i], b: c[(i + 1) % c.length] });
  }
  return walls;
}
