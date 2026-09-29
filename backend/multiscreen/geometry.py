"""MultiScreen table geometry - pure functions, no I/O.

The server owns ONE world coordinate space (the "table"). World units are
millimetres whenever a device was calibrated with a bank card, and a
consistent logical size otherwise (every uncalibrated screen's shorter
edge is normalised to QUICK_SHORT_EDGE_MM), so game sizes defined in
world units look roughly the same physical size on every phone.

Every physical screen is a TILE: an axis-aligned rectangle in the world
(x, y, w, h) plus a rotation in {0, 90, 180, 270} = how far the screen's
own "up" is turned clockwise relative to world up. A screen lying
sideways (rotation 90) has its own top edge facing world right, so its
local width spans the tile's world height.

Local coordinates are the screen as its owner sees it: origin top-left,
x to the right, y down, in world units (the renderer scales them to
pixels). All conversions in both directions live here and nowhere else.

From the tiles, TableWorld derives everything a game needs: which edges
are PASSAGES (shared by two tiles, only the actually overlapping part),
which are WALLS (everything else, including the non-overlapping rest of
a partially shared edge), the adjacency graph, the playable union, and
the validation (overlaps, islands, corner-only contact, sizes).
"""

import math

ROTATIONS = (0, 90, 180, 270)
EDGE_EPS = 0.75            # world units two edges may differ by and still touch
MIN_SHARED_EDGE = 6.0      # shorter common edge = no connection (corner/near-corner touch)
QUICK_SHORT_EDGE_MM = 68.0
MIN_TILE_EDGE = 25.0
MAX_TILE_EDGE = 400.0
MAX_COORD = 5000.0

SIDES = ("top", "right", "bottom", "left")
OPPOSITE_SIDE = {"top": "bottom", "bottom": "top", "left": "right", "right": "left"}
DIR_VECTORS = {"up": (0, -1), "right": (1, 0), "down": (0, 1), "left": (-1, 0)}
VECTOR_DIRS = {v: k for k, v in DIR_VECTORS.items()}
OPPOSITE_DIR = {"up": "down", "down": "up", "left": "right", "right": "left"}
SIDE_OF_DIR = {"up": "top", "right": "right", "down": "bottom", "left": "left"}


# ---------------------------------------------------------------------------
# Device size (quick vs precision calibration)
# ---------------------------------------------------------------------------

def device_local_size(css_w, css_h, px_per_mm=None):
    """Visible size of a screen in world units, in the orientation its
    owner holds it (width = its own left-right extent)."""
    css_w, css_h = float(css_w), float(css_h)
    if px_per_mm:
        w, h = css_w / px_per_mm, css_h / px_per_mm
    else:
        short = min(css_w, css_h)
        k = QUICK_SHORT_EDGE_MM / short
        w, h = css_w * k, css_h * k
    return (round(_clamp(w, MIN_TILE_EDGE, MAX_TILE_EDGE), 2), round(_clamp(h, MIN_TILE_EDGE, MAX_TILE_EDGE), 2))


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# Tile + transforms
# ---------------------------------------------------------------------------

class Tile:
    __slots__ = ("device_id", "x", "y", "w", "h", "rotation", "local_w", "local_h")

    def __init__(self, device_id, x, y, local_w, local_h, rotation=0):
        if rotation not in ROTATIONS:
            raise ValueError("rotation must be 0/90/180/270")
        self.device_id = device_id
        self.x, self.y = float(x), float(y)
        self.local_w, self.local_h = float(local_w), float(local_h)
        self.rotation = rotation
        if rotation in (90, 270):
            self.w, self.h = self.local_h, self.local_w
        else:
            self.w, self.h = self.local_w, self.local_h

    @property
    def right(self):
        return self.x + self.w

    @property
    def bottom(self):
        return self.y + self.h

    @property
    def center(self):
        return (self.x + self.w / 2, self.y + self.h / 2)

    def to_public(self):
        return {
            "deviceId": self.device_id, "x": round(self.x, 2), "y": round(self.y, 2),
            "w": round(self.w, 2), "h": round(self.h, 2), "rotation": self.rotation,
            "localW": round(self.local_w, 2), "localH": round(self.local_h, 2),
        }


def world_to_local(tile, wx, wy):
    u, v = wx - tile.x, wy - tile.y
    r = tile.rotation
    if r == 0:
        return (u, v)
    if r == 90:
        return (v, tile.w - u)
    if r == 180:
        return (tile.w - u, tile.h - v)
    return (tile.h - v, u)


def local_to_world(tile, lx, ly):
    r = tile.rotation
    if r == 0:
        u, v = lx, ly
    elif r == 90:
        u, v = tile.w - ly, lx
    elif r == 180:
        u, v = tile.w - lx, tile.h - ly
    else:
        u, v = ly, tile.h - lx
    return (tile.x + u, tile.y + v)


def world_vec_to_local(rotation, dx, dy):
    if rotation == 0:
        return (dx, dy)
    if rotation == 90:
        return (dy, -dx)
    if rotation == 180:
        return (-dx, -dy)
    return (-dy, dx)


def local_vec_to_world(rotation, dx, dy):
    if rotation == 0:
        return (dx, dy)
    if rotation == 90:
        return (-dy, dx)
    if rotation == 180:
        return (-dx, -dy)
    return (dy, -dx)


def local_dir_to_world(rotation, direction):
    """'up'/'right'/'down'/'left' as the player swiped it on their own
    screen -> the same physical direction in the world."""
    v = local_vec_to_world(rotation, *DIR_VECTORS[direction])
    return VECTOR_DIRS[(int(round(v[0])), int(round(v[1])))]


def world_dir_to_local(rotation, direction):
    v = world_vec_to_local(rotation, *DIR_VECTORS[direction])
    return VECTOR_DIRS[(int(round(v[0])), int(round(v[1])))]


def point_inside(tile, wx, wy, eps=0.0):
    return tile.x - eps <= wx <= tile.right + eps and tile.y - eps <= wy <= tile.bottom + eps


def point_strictly_inside(tile, wx, wy, margin):
    return tile.x + margin < wx < tile.right - margin and tile.y + margin < wy < tile.bottom - margin


# ---------------------------------------------------------------------------
# Passages / walls / adjacency
# ---------------------------------------------------------------------------

class Passage:
    """A shared edge section between tile `a` and tile `b`. `side` is the
    side of `a` it lies on. Vertical passages (a's left/right) run along
    x = coord from start..end in y; horizontal ones along y = coord."""
    __slots__ = ("a", "b", "side", "coord", "start", "end")

    def __init__(self, a, b, side, coord, start, end):
        self.a, self.b, self.side, self.coord, self.start, self.end = a, b, side, coord, start, end

    @property
    def vertical(self):
        return self.side in ("left", "right")

    @property
    def length(self):
        return self.end - self.start

    @property
    def midpoint(self):
        m = (self.start + self.end) / 2
        return (self.coord, m) if self.vertical else (m, self.coord)

    def segment(self):
        if self.vertical:
            return (self.coord, self.start, self.coord, self.end)
        return (self.start, self.coord, self.end, self.coord)

    def to_public(self):
        x1, y1, x2, y2 = self.segment()
        return {"a": self.a, "b": self.b, "side": self.side, "length": round(self.length, 2),
                "x1": round(x1, 2), "y1": round(y1, 2), "x2": round(x2, 2), "y2": round(y2, 2)}


def _interval_overlap(a1, a2, b1, b2):
    return max(a1, b1), min(a2, b2)


def shared_edge_segments(ta, tb, min_len=MIN_SHARED_EDGE):
    """All edge sections ta shares with tb (as Passages seen from ta).
    Corner-only or too-short contact returns nothing."""
    out = []
    if abs(ta.right - tb.x) <= EDGE_EPS:
        s, e = _interval_overlap(ta.y, ta.bottom, tb.y, tb.bottom)
        if e - s >= min_len:
            out.append(Passage(ta.device_id, tb.device_id, "right", ta.right, s, e))
    if abs(tb.right - ta.x) <= EDGE_EPS:
        s, e = _interval_overlap(ta.y, ta.bottom, tb.y, tb.bottom)
        if e - s >= min_len:
            out.append(Passage(ta.device_id, tb.device_id, "left", ta.x, s, e))
    if abs(ta.bottom - tb.y) <= EDGE_EPS:
        s, e = _interval_overlap(ta.x, ta.right, tb.x, tb.right)
        if e - s >= min_len:
            out.append(Passage(ta.device_id, tb.device_id, "bottom", ta.bottom, s, e))
    if abs(tb.bottom - ta.y) <= EDGE_EPS:
        s, e = _interval_overlap(ta.x, ta.right, tb.x, tb.right)
        if e - s >= min_len:
            out.append(Passage(ta.device_id, tb.device_id, "top", ta.y, s, e))
    return out


def _edge_of(tile, side):
    if side == "top":
        return (tile.y, tile.x, tile.right)
    if side == "bottom":
        return (tile.bottom, tile.x, tile.right)
    if side == "left":
        return (tile.x, tile.y, tile.bottom)
    return (tile.right, tile.y, tile.bottom)


def _subtract_intervals(start, end, holes):
    parts = [(start, end)]
    for hs, he in sorted(holes):
        nxt = []
        for s, e in parts:
            if he <= s or hs >= e:
                nxt.append((s, e))
                continue
            if hs > s:
                nxt.append((s, hs))
            if he < e:
                nxt.append((he, e))
        parts = nxt
    return [(s, e) for s, e in parts if e - s > 1e-6]


def _point_segment_distance(px, py, x1, y1, x2, y2):
    if x1 == x2:
        cy = _clamp(py, min(y1, y2), max(y1, y2))
        return math.hypot(px - x1, py - cy)
    cx = _clamp(px, min(x1, x2), max(x1, x2))
    return math.hypot(px - cx, py - y1)


def _rects_overlap_area(a, b):
    ox = min(a.right, b.right) - max(a.x, b.x)
    oy = min(a.bottom, b.bottom) - max(a.y, b.y)
    return ox > EDGE_EPS and oy > EDGE_EPS


class TableWorld:
    """The shared world built from a layout. Generic engine API every
    MultiScreen game uses - games never do their own edge math."""

    def __init__(self, tiles, min_passage=MIN_SHARED_EDGE):
        self.tiles = list(tiles)
        self.by_id = {t.device_id: t for t in self.tiles}
        self.min_passage = max(min_passage, MIN_SHARED_EDGE)
        # every geometric contact (each shared section once per direction,
        # a -> b), and the ones wide enough for the current game: only
        # those are open - a narrower one is simply wall for this game
        self.all_passages = []
        for a in self.tiles:
            for b in self.tiles:
                if a is not b:
                    self.all_passages.extend(shared_edge_segments(a, b))
        self.passages = [p for p in self.all_passages if p.length >= self.min_passage]
        self.walls = self._compute_walls()
        self.adjacency = self._compute_adjacency()

    # ----- structure -----

    def _compute_walls(self):
        walls = []
        for t in self.tiles:
            for side in SIDES:
                coord, s, e = _edge_of(t, side)
                holes = [(p.start, p.end) for p in self.passages if p.a == t.device_id and p.side == side]
                for ws, we in _subtract_intervals(s, e, holes):
                    if side in ("left", "right"):
                        walls.append((coord, ws, coord, we))
                    else:
                        walls.append((ws, coord, we, coord))
        return walls

    def _compute_adjacency(self):
        adj = {t.device_id: {s: [] for s in SIDES} for t in self.tiles}
        for p in self.passages:
            adj[p.a][p.side].append({"neighbor": p.b, "start": round(p.start, 2), "end": round(p.end, 2),
                                     "length": round(p.length, 2)})
        return adj

    def neighbors(self, device_id):
        return sorted({p.b for p in self.passages if p.a == device_id})

    def get_shared_passage(self, a, b):
        return [p for p in self.passages if p.a == a and p.b == b]

    def get_neighbors_for_boundary(self, device_id, side):
        return self.adjacency.get(device_id, {}).get(side, [])

    @property
    def bounds(self):
        if not self.tiles:
            return (0.0, 0.0, 0.0, 0.0)
        return (min(t.x for t in self.tiles), min(t.y for t in self.tiles),
                max(t.right for t in self.tiles), max(t.bottom for t in self.tiles))

    # ----- queries -----

    def contains_point(self, wx, wy):
        return any(point_inside(t, wx, wy) for t in self.tiles)

    def get_tile_for_point(self, wx, wy, prefer=None):
        """Tile the point is on. A point exactly on a shared edge belongs
        to both - `prefer` (e.g. the current one) wins then."""
        hits = [t for t in self.tiles if point_inside(t, wx, wy)]
        if not hits:
            return None
        if prefer is not None and any(t.device_id == prefer for t in hits):
            return self.by_id[prefer]
        return hits[0]

    def wall_distance(self, wx, wy):
        if not self.walls:
            return math.inf
        return min(_point_segment_distance(wx, wy, *w) for w in self.walls)

    def is_playable_point(self, wx, wy, radius=0.0):
        """Inside the union and at least `radius` away from every wall -
        i.e. a circle of that radius fits without touching a wall."""
        return self.contains_point(wx, wy) and self.wall_distance(wx, wy) >= radius

    def get_boundary_collision(self, wx, wy, radius):
        """None if a circle at (wx, wy) is fine, else "outside"/"wall"."""
        if not self.contains_point(wx, wy):
            return "outside"
        if self.wall_distance(wx, wy) < radius:
            return "wall"
        return None

    def exit_along(self, device_id, wx, wy, direction):
        """Where a point moving straight in `direction` leaves its tile,
        how far that is, and which tile it would enter (None = wall)."""
        t = self.by_id[device_id]
        dx, dy = DIR_VECTORS[direction]
        if dx > 0:
            dist, ex, ey = t.right - wx, t.right, wy
        elif dx < 0:
            dist, ex, ey = wx - t.x, t.x, wy
        elif dy > 0:
            dist, ex, ey = t.bottom - wy, wx, t.bottom
        else:
            dist, ex, ey = wy - t.y, wx, t.y
        side = SIDE_OF_DIR[direction]
        target = None
        for p in self.passages:
            if p.a != device_id or p.side != side:
                continue
            along = ey if p.vertical else ex
            if p.start <= along <= p.end:
                target = p.b
                break
        return {"distance": max(0.0, dist), "point": (ex, ey), "target": target}

    def tiles_intersecting(self, x1, y1, x2, y2):
        """Visibility-culling helper: tiles whose rect overlaps a world box."""
        return [t.device_id for t in self.tiles if t.x <= x2 and t.right >= x1 and t.y <= y2 and t.bottom >= y1]

    # ----- validation -----

    def connected_components(self):
        ids = [t.device_id for t in self.tiles]
        seen, comps = set(), []
        for start in ids:
            if start in seen:
                continue
            comp, stack = [], [start]
            seen.add(start)
            while stack:
                cur = stack.pop()
                comp.append(cur)
                for p in self.passages:
                    if p.a == cur and p.b not in seen:
                        seen.add(p.b)
                        stack.append(p.b)
            comps.append(comp)
        return comps

    def validate(self, min_devices=2, names=None):
        """Returns a list of problems ({code, severity, message, devices}).
        severity "error" blocks the start, "warning" is only shown.
        Messages are for players, not developers."""
        names = names or {}
        label = lambda d: names.get(d, "Ein Handy")  # noqa: E731
        problems = []

        def add(code, message, devices, severity="error"):
            problems.append({"code": code, "severity": severity, "message": message, "devices": devices})

        if len(self.tiles) < min_devices:
            add("too_few", f"Legt mindestens {min_devices} Handys auf die Spielfläche.", [])
        for i, a in enumerate(self.tiles):
            for b in self.tiles[i + 1:]:
                if _rects_overlap_area(a, b):
                    add("overlap", f"Displays überlappen: {label(a.device_id)} und {label(b.device_id)}.", [a.device_id, b.device_id])
        for t in self.tiles:
            if not (MIN_TILE_EDGE <= t.w <= MAX_TILE_EDGE and MIN_TILE_EDGE <= t.h <= MAX_TILE_EDGE):
                add("size", f"{label(t.device_id)} hat eine ungültige Größe.", [t.device_id])
        for p in self.all_passages:
            if p.length < self.min_passage and p.a < p.b:
                add("narrow", f"Die Verbindung {label(p.a)} ↔ {label(p.b)} ist zu schmal für dieses Spiel - dort ist eine Wand.",
                    [p.a, p.b], severity="warning")
        if len(self.tiles) >= 2 and not any(pr["code"] == "overlap" for pr in problems):
            comps = self.connected_components()
            if len(comps) > 1:
                main = max(comps, key=len)
                for comp in comps:
                    if comp is main:
                        continue
                    who = ", ".join(label(d) for d in comp)
                    verb = "ist" if len(comp) == 1 else "sind"
                    add("island", f"{who} {verb} noch nicht mit der gemeinsamen Spielfläche verbunden.", comp)
        return problems

    def to_public(self, names=None, min_devices=2):
        x1, y1, x2, y2 = self.bounds
        return {
            "tiles": [t.to_public() for t in self.tiles],
            "passages": [dict(p.to_public(), ok=p.length >= self.min_passage) for p in self.all_passages if p.a < p.b],
            "adjacency": self.adjacency,
            "walls": [[round(v, 2) for v in w] for w in self.walls],
            "bounds": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
            "minPassage": self.min_passage,
            "problems": self.validate(min_devices=min_devices, names=names),
        }


def tour_path(world, start_id=None):
    """A polyline visiting every connected tile (tile centres via passage
    midpoints, depth-first, walking back the same way) - the setup test
    wave follows it across every screen."""
    if not world.tiles:
        return []
    start_id = start_id if start_id in world.by_id else world.tiles[0].device_id
    pts = [world.by_id[start_id].center]
    seen = {start_id}

    def visit(cur):
        for p in sorted((p for p in world.passages if p.a == cur), key=lambda p: (p.side, p.start)):
            if p.b in seen:
                continue
            seen.add(p.b)
            pts.append(p.midpoint)
            pts.append(world.by_id[p.b].center)
            visit(p.b)
            pts.append(p.midpoint)
            pts.append(world.by_id[cur].center)

    visit(start_id)
    return [(round(x, 2), round(y, 2)) for x, y in pts]
