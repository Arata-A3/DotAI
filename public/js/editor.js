// ピクセル編集キャンバス（ペン・消しゴム・塗りつぶし・スポイト、左右対称描き、複数コマ、Undo/Redo）
import { cloneDoc, frameGrid } from "./pixel.js";

const UNDO_LIMIT = 100;

// ブレゼンハムの直線（両端を含む）
function linePoints(a, b) {
  const pts = [];
  let { x, y } = a;
  const dx = Math.abs(b.x - x), dy = -Math.abs(b.y - y);
  const sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push({ x, y });
    if (x === b.x && y === b.y) return pts;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

// Shift押下時：0°・45°・90°に固定
function snapAngle(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) > 2 * Math.abs(dy)) return { x: b.x, y: a.y };
  if (Math.abs(dy) > 2 * Math.abs(dx)) return { x: a.x, y: b.y };
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: a.x + Math.sign(dx) * d, y: a.y + Math.sign(dy) * d };
}

// L字の角を取り除き、線を1px幅に整える（ドット絵の「ピクセルパーフェクト」）
function pixelPerfect(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = out[out.length - 1];
    const n = pts[i + 1];
    if (a && n && (a.x === p.x || a.y === p.y) && (n.x === p.x || n.y === p.y) && a.x !== n.x && a.y !== n.y) continue;
    out.push(p);
  }
  return out;
}

// 点を順に直線でつなぐ折れ線
function polylinePoints(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) out.push(...linePoints(pts[i - 1], pts[i]).slice(1));
  return out;
}

// すべての点を通るなめらかな曲線（セントリペタル Catmull-Rom スプライン。尖りやループが出にくい）
function splinePoints(pts) {
  if (pts.length < 3) return polylinePoints(pts);
  // 両端は外側に1点延長して、端の区間も曲線にする
  const ext = [
    { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y },
    ...pts,
    { x: 2 * pts.at(-1).x - pts.at(-2).x, y: 2 * pts.at(-1).y - pts.at(-2).y },
  ];
  const lerp = (p, q, t0, t1, t) => {
    const k = (t - t0) / (t1 - t0);
    return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
  };
  const knot = (t, p, q) => t + Math.max(1e-6, Math.sqrt(Math.hypot(q.x - p.x, q.y - p.y)));
  const out = [];
  let prev = null;
  for (let i = 1; i < ext.length - 2; i++) {
    const [p0, p1, p2, p3] = [ext[i - 1], ext[i], ext[i + 1], ext[i + 2]];
    const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    const steps = Math.max(2, Math.ceil(3 * Math.hypot(p2.x - p1.x, p2.y - p1.y)));
    for (let s = 0; s <= steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
      const c = lerp(b1, b2, t1, t2, t);
      const q = { x: Math.round(c.x), y: Math.round(c.y) };
      if (!prev) out.push(q);
      else if (prev.x !== q.x || prev.y !== q.y) out.push(...linePoints(prev, q).slice(1));
      prev = q;
    }
  }
  return pixelPerfect(out);
}

const samePoint = (a, b) => a && b && a.x === b.x && a.y === b.y;

export class Editor {
  constructor(canvas, { onChange, onPick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange || (() => {});
    this.onPick = onPick || (() => {});
    this.doc = null;
    this.frame = 0;
    this.tool = "pen";
    this.color = 0;
    this.zoom = 16;
    this.showGrid = true;
    this.mirror = false;
    this.onion = false;
    this.undoStack = [];
    this.redoStack = [];
    this.hover = null;
    this.drawing = false;
    this.shape = null;
    this.bindEvents();
  }

  // 編集中のコマ（pixels は doc 内の配列そのものなので、書き換えると doc に反映される）
  get grid() {
    return this.doc && frameGrid(this.doc, this.frame);
  }

  get frameCount() {
    return this.doc ? this.doc.frames.length : 0;
  }

  setDoc(doc, { keepHistory = false } = {}) {
    if (keepHistory && this.doc) this.pushUndo();
    else {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.doc = cloneDoc({ fps: 8, ...doc });
    this.frame = 0;
    this.clampColor();
    this.fitZoom();
    this.changed();
  }

  setGrid(grid, opts) {
    this.setDoc({ width: grid.width, height: grid.height, palette: grid.palette, frames: [grid.pixels] }, opts);
  }

  changed() {
    this.render();
    this.onChange(this.grid);
  }

  clampColor() {
    if (this.color >= this.doc.palette.length) this.color = Math.max(0, this.doc.palette.length - 1);
  }

  // 今のコマだけに加工を適用（パレットへの色の追加はOK、並べ替えはNG）
  apply(fn) {
    if (!this.doc) return;
    this.pushUndo();
    const g = fn(this.grid);
    this.doc.palette = [...g.palette];
    this.doc.frames[this.frame] = [...g.pixels];
    this.clampColor();
    this.changed();
  }

  // doc 全体に加工を適用（減色・リサイズ・全コマ処理など）
  applyDoc(fn) {
    if (!this.doc) return;
    this.pushUndo();
    const before = this.doc;
    this.doc = cloneDoc(fn(cloneDoc(before)));
    this.frame = Math.min(this.frame, this.doc.frames.length - 1);
    this.clampColor();
    if (before.width !== this.doc.width || before.height !== this.doc.height) this.fitZoom();
    this.changed();
  }

  /* ---------- コマ操作 ---------- */
  setFrame(i) {
    this.shape = null;
    this.frame = Math.max(0, Math.min(this.frameCount - 1, i));
    this.changed();
  }

  addFrame(copy = true) {
    this.pushUndo();
    const f = copy ? [...this.grid.pixels] : new Array(this.doc.width * this.doc.height).fill(-1);
    this.doc.frames.splice(this.frame + 1, 0, f);
    this.frame++;
    this.changed();
  }

  deleteFrame() {
    if (this.frameCount <= 1) return;
    this.pushUndo();
    this.doc.frames.splice(this.frame, 1);
    this.frame = Math.min(this.frame, this.frameCount - 1);
    this.changed();
  }

  moveFrame(dir) {
    const to = this.frame + dir;
    if (to < 0 || to >= this.frameCount) return;
    this.pushUndo();
    const f = this.doc.frames;
    [f[this.frame], f[to]] = [f[to], f[this.frame]];
    this.frame = to;
    this.changed();
  }

  /* ---------- 表示 ---------- */
  fitZoom() {
    const area = this.canvas.parentElement;
    const max = Math.min(area.clientWidth - 24, area.clientHeight - 24, 640);
    this.zoom = Math.max(2, Math.floor(max / Math.max(this.doc.width, this.doc.height)));
  }

  setZoom(z) {
    this.zoom = Math.min(64, Math.max(1, z));
    this.render();
  }

  /* ---------- Undo ---------- */
  pushUndo() {
    this.undoStack.push({ doc: cloneDoc(this.doc), frame: this.frame });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  restore(from, to) {
    if (!from.length) return;
    to.push({ doc: cloneDoc(this.doc), frame: this.frame });
    const s = from.pop();
    const sizeChanged = s.doc.width !== this.doc.width || s.doc.height !== this.doc.height;
    this.doc = s.doc;
    this.frame = Math.min(s.frame, this.frameCount - 1);
    this.clampColor();
    if (sizeChanged) this.fitZoom();
    this.changed();
  }

  undo() {
    this.restore(this.undoStack, this.redoStack);
  }

  redo() {
    this.restore(this.redoStack, this.undoStack);
  }

  /* ---------- 定規（直線・曲線） ---------- */
  // クリックで点を打ち続け、ダブルクリック（または Enter）で確定。
  // 直線は点を直線でつなぎ、曲線はすべての点を通るなめらかな線にする。cursor は次の点の仮位置
  shapePoints(withCursor = true) {
    const s = this.shape;
    if (!s) return [];
    const pts = withCursor && s.cursor && !samePoint(s.cursor, s.pts.at(-1)) ? [...s.pts, s.cursor] : s.pts;
    return s.type === "line" ? polylinePoints(pts) : splinePoints(pts);
  }

  finishShape() {
    const s = this.shape;
    if (!s) return;
    if (s.pts.length < 2) return this.cancelShape();
    const pts = this.shapePoints(false);
    this.shape = null;
    this.pushUndo();
    const { width: w, height: h } = this.doc;
    for (const p of pts) if (p.x >= 0 && p.y >= 0 && p.x < w && p.y < h) this.paint(p, "pen");
    this.changed();
  }

  cancelShape() {
    if (!this.shape) return;
    this.shape = null;
    this.render();
  }

  // 最後に打った点を取り消す（Backspace）
  removeShapePoint() {
    const s = this.shape;
    if (!s) return;
    s.pts.pop();
    if (!s.pts.length) this.shape = null;
    this.render();
  }

  addShapePoint(p) {
    if (!this.shape) this.shape = { type: this.tool, pts: [], cursor: null };
    if (!samePoint(p, this.shape.pts.at(-1))) this.shape.pts.push(p);
  }

  onShapeMove(cell, shift) {
    const s = this.shape;
    s.cursor = shift ? snapAngle(s.pts.at(-1), cell) : cell;
  }

  // ドラッグして離した場合は、離した位置にも点を打つ
  onShapeUp() {
    const s = this.shape;
    if (s.cursor && s.dragging) this.addShapePoint(s.cursor);
    s.dragging = false;
    s.downAt = null;
  }

  /* ---------- 描画操作 ---------- */
  cellAt(e, clip = true) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.doc.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.doc.height);
    if (clip && (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height)) return null;
    return { x, y };
  }

  bindEvents() {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      if (!this.doc) return;
      const cell = this.cellAt(e);
      if (!cell) return;
      c.setPointerCapture(e.pointerId);
      // 定規の途中で右クリックしたら取り消し
      if (this.shape && e.button === 2) return this.cancelShape();
      if ((this.tool === "line" || this.tool === "curve") && e.button === 0) {
        const s = this.shape;
        // Shift 中は固定された角度の位置に点を打つ
        this.addShapePoint(s && e.shiftKey && s.cursor ? s.cursor : cell);
        this.shape.downAt = cell;
        return this.render();
      }
      // 右クリックは一時的に消しゴム
      const tool = e.button === 2 ? "eraser" : this.tool;
      if (tool === "picker") {
        const v = this.grid.pixels[cell.y * this.doc.width + cell.x];
        if (v >= 0) {
          this.color = v;
          this.onPick(v);
        }
        return;
      }
      this.pushUndo();
      if (tool === "fill") {
        this.fill(cell.x, cell.y, this.color);
        this.changed();
        return;
      }
      this.drawing = { tool, last: cell };
      this.paint(cell, tool);
      this.render();
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.doc) return;
      const cell = this.cellAt(e);
      this.hover = cell;
      if (this.shape) {
        const raw = this.cellAt(e, false);
        if (e.buttons & 1 && this.shape.downAt && !samePoint(raw, this.shape.downAt)) this.shape.dragging = true;
        this.onShapeMove(raw, e.shiftKey);
      }
      if (this.drawing && cell) {
        // 速く動かしても線が途切れないよう前回位置から補間
        const { last } = this.drawing;
        const steps = Math.max(Math.abs(cell.x - last.x), Math.abs(cell.y - last.y));
        for (let i = 1; i <= steps; i++) {
          this.paint({
            x: Math.round(last.x + ((cell.x - last.x) * i) / steps),
            y: Math.round(last.y + ((cell.y - last.y) * i) / steps),
          }, this.drawing.tool);
        }
        this.drawing.last = cell;
      }
      this.render();
    });
    const end = () => {
      if (this.shape) this.onShapeUp();
      if (this.drawing) {
        this.drawing = false;
        this.onChange(this.grid);
      }
    };
    c.addEventListener("dblclick", () => this.finishShape());
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", () => {
      this.hover = null;
      this.render();
    });
  }

  paint({ x, y }, tool) {
    const v = tool === "eraser" ? -1 : this.color;
    const w = this.doc.width;
    const pixels = this.doc.frames[this.frame];
    pixels[y * w + x] = v;
    if (this.mirror) pixels[y * w + (w - 1 - x)] = v;
  }

  fill(x, y, v) {
    const { width: w, height: h } = this.doc;
    const pixels = this.doc.frames[this.frame];
    const target = pixels[y * w + x];
    if (target === v) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const i = cy * w + cx;
      if (pixels[i] !== target) continue;
      pixels[i] = v;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  render() {
    const g = this.grid;
    if (!g) return;
    const z = this.zoom;
    const c = this.canvas;
    if (c.width !== g.width * z || c.height !== g.height * z) {
      c.width = g.width * z;
      c.height = g.height * z;
    }
    const ctx = this.ctx;
    // 透明部分の市松模様
    const check = Math.max(4, Math.floor(z / 2));
    ctx.fillStyle = "#cfcfcf";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#f2f2f2";
    for (let y = 0; y < c.height; y += check) {
      for (let x = (y / check) % 2 ? check : 0; x < c.width; x += check * 2) ctx.fillRect(x, y, check, check);
    }
    // オニオンスキン：前のコマを薄く表示
    if (this.onion && this.frameCount > 1) {
      const prev = this.doc.frames[(this.frame - 1 + this.frameCount) % this.frameCount];
      ctx.globalAlpha = 0.3;
      prev.forEach((v, i) => {
        if (v < 0 || g.pixels[i] >= 0) return;
        ctx.fillStyle = g.palette[v];
        ctx.fillRect((i % g.width) * z, Math.floor(i / g.width) * z, z, z);
      });
      ctx.globalAlpha = 1;
    }
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const v = g.pixels[y * g.width + x];
        if (v < 0) continue;
        ctx.fillStyle = g.palette[v];
        ctx.fillRect(x * z, y * z, z, z);
      }
    }
    if (this.showGrid && z >= 6) {
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < g.width; x++) {
        ctx.moveTo(x * z + 0.5, 0);
        ctx.lineTo(x * z + 0.5, c.height);
      }
      for (let y = 1; y < g.height; y++) {
        ctx.moveTo(0, y * z + 0.5);
        ctx.lineTo(c.width, y * z + 0.5);
      }
      ctx.stroke();
    }
    if (this.mirror) {
      ctx.strokeStyle = "rgba(255,80,80,0.6)";
      ctx.beginPath();
      ctx.moveTo(c.width / 2, 0);
      ctx.lineTo(c.width / 2, c.height);
      ctx.stroke();
    }
    // 定規のプレビューと、打った点の目印
    if (this.shape) {
      ctx.fillStyle = g.palette[this.color] || "#000";
      for (const p of this.shapePoints()) {
        ctx.fillRect(p.x * z, p.y * z, z, z);
        if (this.mirror) ctx.fillRect((g.width - 1 - p.x) * z, p.y * z, z, z);
      }
      ctx.strokeStyle = "#00e5ff";
      ctx.lineWidth = 2;
      for (const p of this.shape.pts) ctx.strokeRect(p.x * z + 1, p.y * z + 1, z - 2, z - 2);
    }
    if (this.hover) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(this.hover.x * z + 1, this.hover.y * z + 1, z - 2, z - 2);
    }
  }
}
