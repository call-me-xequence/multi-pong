package geometry

import "math"

// Point is a 2D point/vector in world space. The polygon center is (0,0).
type Point struct {
	X, Y float64
}

// Segment is a line segment defined by two points.
type Segment struct {
	A, B Point
}

// Vector helpers

func Sub(a, b Point) Point         { return Point{a.X - b.X, a.Y - b.Y} }
func Add(a, b Point) Point         { return Point{a.X + b.X, a.Y + b.Y} }
func Mul(a Point, s float64) Point { return Point{a.X * s, a.Y * s} }
func Dot(a, b Point) float64       { return a.X*b.X + a.Y*b.Y }
func Len(a Point) float64          { return math.Hypot(a.X, a.Y) }
func Norm(a Point) Point {
	l := Len(a)
	if l == 0 {
		return Point{}
	}
	return Point{a.X / l, a.Y / l}
}
func Perp(a Point) Point { return Point{-a.Y, a.X} }

// GeneratePolygon returns the vertices of a regular polygon with `sides` sides,
// centered at (0,0) with circumradius `radius`.
// The first vertex is placed at the top (-90 degrees). Vertices are returned in
// counter-clockwise order (in standard math coordinates, +Y up).
func GeneratePolygon(sides int, radius float64) []Point {
	if sides < 3 {
		sides = 3
	}
	vertices := make([]Point, 0, sides)
	for i := 0; i < sides; i++ {
		angle := -math.Pi/2 + float64(i)*2*math.Pi/float64(sides)
		vertices = append(vertices, Point{
			X: radius * math.Cos(angle),
			Y: radius * math.Sin(angle),
		})
	}
	return vertices
}

// ChamferVertices cuts off each corner of the polygon with a straight line placed
// at distance `chamferRadius` from the vertex along both adjacent edges.
// It returns an ordered list of 2*N points describing the chamfered polygon.
//
// The returned points alternate:
//   - even-indexed segments [2i, 2i+1] are the shortened original edges
//     (these become the goal faces, face i);
//   - odd-indexed segments [2i+1, 2i+2] are the chamfer cuts.
func ChamferVertices(vertices []Point, chamferRadius float64) []Point {
	n := len(vertices)
	if n < 3 {
		return vertices
	}
	// For each vertex i:
	//   a[i] lies on edge (i-1 -> i) at distance r from vertex i
	//   b[i] lies on edge (i -> i+1) at distance r from vertex i
	a := make([]Point, n)
	b := make([]Point, n)
	for i := 0; i < n; i++ {
		prev := vertices[(i-1+n)%n]
		cur := vertices[i]
		next := vertices[(i+1)%n]
		a[i] = pointAlong(cur, prev, chamferRadius)
		b[i] = pointAlong(cur, next, chamferRadius)
	}

	// Ordered counter-clockwise traversal:
	//   b[0], a[1], b[1], a[2], ..., a[n-1], b[n-1], a[0]
	out := make([]Point, 0, 2*n)
	out = append(out, b[0])
	for i := 1; i < n; i++ {
		out = append(out, a[i], b[i])
	}
	out = append(out, a[0])
	return out
}

// pointAlong returns the point on the segment from->to at distance `dist` from `from`.
func pointAlong(from, to Point, dist float64) Point {
	d := Sub(to, from)
	l := Len(d)
	if l == 0 {
		return from
	}
	return Add(from, Mul(d, dist/l))
}

// FaceMidAngle returns the world-space angle (radians) pointing from the polygon
// center to the middle of face i of a regular N-gon.
func FaceMidAngle(sides, face int) float64 {
	return -math.Pi/2 + (float64(face)+0.5)*2*math.Pi/float64(sides)
}

// ClosestPointOnSegment returns the closest point on segment s to point p.
func ClosestPointOnSegment(p Point, s Segment) Point {
	ab := Sub(s.B, s.A)
	ap := Sub(p, s.A)
	lenSq := Dot(ab, ab)
	t := 0.0
	if lenSq > 0 {
		t = Dot(ap, ab) / lenSq
		if t < 0 {
			t = 0
		} else if t > 1 {
			t = 1
		}
	}
	return Add(s.A, Mul(ab, t))
}

// DistToSegment returns the distance from point p to segment s.
func DistToSegment(p Point, s Segment) float64 {
	return Len(Sub(p, ClosestPointOnSegment(p, s)))
}
