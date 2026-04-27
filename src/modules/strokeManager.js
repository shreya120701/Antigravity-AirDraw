// ─────────────────────────────────────────────────────────────────────────────
// Ramer-Douglas-Peucker stroke simplification
// ─────────────────────────────────────────────────────────────────────────────
function rdpSimplify(points, epsilon = 2.5) {
  if (points.length <= 2) return points;
  const start = points[0];
  const end = points[points.length - 1];
  let maxDist = 0, maxIdx = 0;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  for (let i = 1; i < points.length - 1; i++) {
    let dist;
    if (len2 === 0) {
      const ex = points[i].x - start.x, ey = points[i].y - start.y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      const t = Math.max(0, Math.min(1, ((points[i].x - start.x) * dx + (points[i].y - start.y) * dy) / len2));
      const nx = start.x + t * dx - points[i].x, ny = start.y + t * dy - points[i].y;
      dist = Math.sqrt(nx * nx + ny * ny);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

// ─────────────────────────────────────────────────────────────────────────────
// SpatialGrid – O(1) bucket lookup for hit-testing
// ─────────────────────────────────────────────────────────────────────────────
class SpatialGrid {
  constructor(cellSize = 80) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.strokeCells = new Map();
  }
  _key(c, r) { return `${c},${r}`; }
  _cellsForAABB(minX, minY, maxX, maxY) {
    const c0 = Math.floor(minX / this.cellSize), r0 = Math.floor(minY / this.cellSize);
    const c1 = Math.floor(maxX / this.cellSize), r1 = Math.floor(maxY / this.cellSize);
    const keys = [];
    for (let c = c0; c <= c1; c++)
      for (let r = r0; r <= r1; r++)
        keys.push(this._key(c, r));
    return keys;
  }
  _aabb(points, pad = 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }
  insert(stroke) {
    const { minX, minY, maxX, maxY } = this._aabb(stroke.points, stroke.lineWidth / 2);
    const keys = this._cellsForAABB(minX, minY, maxX, maxY);
    this.strokeCells.set(stroke.id, new Set(keys));
    for (const k of keys) {
      if (!this.cells.has(k)) this.cells.set(k, new Set());
      this.cells.get(k).add(stroke.id);
    }
  }
  remove(id) {
    const cellSet = this.strokeCells.get(id);
    if (!cellSet) return;
    for (const k of cellSet) {
      const cell = this.cells.get(k);
      if (cell) { cell.delete(id); if (cell.size === 0) this.cells.delete(k); }
    }
    this.strokeCells.delete(id);
  }
  query(x, y, radius) {
    const keys = this._cellsForAABB(x - radius, y - radius, x + radius, y + radius);
    const result = new Set();
    for (const k of keys) { const c = this.cells.get(k); if (c) for (const id of c) result.add(id); }
    return result;
  }
  rebuild(strokes) {
    this.cells.clear(); this.strokeCells.clear();
    for (const s of strokes) this.insert(s);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command types
// ─────────────────────────────────────────────────────────────────────────────
const CMD = { ADD: 'ADD', REMOVE: 'REMOVE', TRANSFORM: 'TRANSFORM', CLEAR: 'CLEAR' };

// ─────────────────────────────────────────────────────────────────────────────
// StrokeManager
// ─────────────────────────────────────────────────────────────────────────────
export class StrokeManager {
  constructor() {
    this.strokes = [];
    this._map = new Map();
    this._nextId = 1;
    this._undoStack = [];
    this._redoStack = [];
    this._grid = new SpatialGrid(80);
    this._pendingTransform = null;
  }

  _pushUndo(cmd) { this._undoStack.push(cmd); this._redoStack = []; }

  _applyAdd(stroke) {
    this.strokes.push(stroke);
    this._map.set(stroke.id, stroke);
    this._grid.insert(stroke);
  }

  _applyRemove(id) {
    this.strokes = this.strokes.filter(s => s.id !== id);
    this._map.delete(id);
    this._grid.remove(id);
  }

  addStroke(points, color, lineWidth, glowIntensity) {
    const simplified = rdpSimplify(points, 2.5);
    const stroke = {
      id: this._nextId++,
      points: simplified,
      color, lineWidth, glowIntensity,
      transform: { tx: 0, ty: 0, scale: 1, rotation: 0 },
    };
    this._applyAdd(stroke);
    this._pushUndo({ type: CMD.ADD, stroke });
    return stroke;
  }

  removeStroke(id) {
    const stroke = this._map.get(id);
    if (!stroke) return;
    this._applyRemove(id);
    this._pushUndo({ type: CMD.REMOVE, stroke });
  }

  saveTransformCheckpoint(id) {
    const stroke = this._map.get(id);
    if (!stroke) return;
    this._pendingTransform = { id, before: { ...stroke.transform } };
  }

  commitTransformCheckpoint(id) {
    if (!this._pendingTransform || this._pendingTransform.id !== id) return;
    const stroke = this._map.get(id);
    if (!stroke) { this._pendingTransform = null; return; }
    this._pushUndo({ type: CMD.TRANSFORM, id, before: this._pendingTransform.before, after: { ...stroke.transform } });
    this._pendingTransform = null;
    this._grid.remove(id);
    this._grid.insert(stroke);
  }

  clear() {
    if (this.strokes.length === 0) return;
    const snapshot = [...this.strokes];
    this.strokes = []; this._map.clear(); this._grid.rebuild([]);
    this._pushUndo({ type: CMD.CLEAR, snapshot });
  }

  undo() {
    const cmd = this._undoStack.pop();
    if (!cmd) return;
    switch (cmd.type) {
      case CMD.ADD:       this._applyRemove(cmd.stroke.id); break;
      case CMD.REMOVE:    this._applyAdd(cmd.stroke); break;
      case CMD.TRANSFORM: {
        const s = this._map.get(cmd.id);
        if (s) { s.transform = { ...cmd.before }; this._grid.remove(cmd.id); this._grid.insert(s); }
        break;
      }
      case CMD.CLEAR: for (const s of cmd.snapshot) this._applyAdd(s); break;
    }
    this._redoStack.push(cmd);
  }

  redo() {
    const cmd = this._redoStack.pop();
    if (!cmd) return;
    switch (cmd.type) {
      case CMD.ADD:       this._applyAdd(cmd.stroke); break;
      case CMD.REMOVE:    this._applyRemove(cmd.stroke.id); break;
      case CMD.TRANSFORM: {
        const s = this._map.get(cmd.id);
        if (s) { s.transform = { ...cmd.after }; this._grid.remove(cmd.id); this._grid.insert(s); }
        break;
      }
      case CMD.CLEAR: for (const s of cmd.snapshot) this._applyRemove(s.id); break;
    }
    this._undoStack.push(cmd);
  }

  findIntersectingStrokes(x, y, radius) {
    const hits = [];
    for (const id of this._grid.query(x, y, radius)) {
      const s = this._map.get(id);
      if (s && this._doesStrokeIntersectCircle(s, x, y, radius)) hits.push(id);
    }
    return hits;
  }

  findNearestStroke(x, y, threshold) {
    let nearestId = null, minDist = threshold;
    for (const id of this._grid.query(x, y, threshold)) {
      const s = this._map.get(id);
      if (!s) continue;
      for (let i = 0; i < s.points.length - 1; i++) {
        const d = this._distanceToSegment(x, y, s.points[i].x, s.points[i].y, s.points[i+1].x, s.points[i+1].y);
        if (d < minDist) { minDist = d; nearestId = id; }
      }
      if (s.points.length === 1) {
        const dx = x - s.points[0].x, dy = y - s.points[0].y;
        const d = Math.sqrt(dx*dx + dy*dy);
        if (d < minDist) { minDist = d; nearestId = id; }
      }
    }
    return nearestId;
  }

  getStroke(id) { return this._map.get(id) ?? null; }
  getAllStrokes() { return this.strokes; }

  moveStroke(id, dx, dy) {
    const s = this._map.get(id);
    if (!s) return;
    for (const pt of s.points) { pt.x += dx; pt.y += dy; }
    this._grid.remove(id); this._grid.insert(s);
  }

  _doesStrokeIntersectCircle(stroke, cx, cy, radius) {
    for (let i = 0; i < stroke.points.length - 1; i++) {
      if (this._distanceToSegment(cx, cy, stroke.points[i].x, stroke.points[i].y, stroke.points[i+1].x, stroke.points[i+1].y) <= radius + stroke.lineWidth / 2) return true;
    }
    if (stroke.points.length === 1) {
      const dx = cx - stroke.points[0].x, dy = cy - stroke.points[0].y;
      if (Math.sqrt(dx*dx + dy*dy) <= radius + stroke.lineWidth / 2) return true;
    }
    return false;
  }

  _distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    if (dx === 0 && dy === 0) return Math.sqrt((px-x1)**2 + (py-y1)**2);
    const t = Math.max(0, Math.min(1, ((px-x1)*dx + (py-y1)*dy) / (dx*dx + dy*dy)));
    return Math.sqrt((px-(x1+t*dx))**2 + (py-(y1+t*dy))**2);
  }
}
