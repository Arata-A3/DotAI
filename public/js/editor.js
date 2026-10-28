// ピクセル編集キャンバス（ペン・消しゴム・塗りつぶし・スポイト、左右対称描き、複数コマ、Undo/Redo）
import { cloneDoc, frameGrid } from "./pixel.js";

const UNDO_LIMIT = 100;

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

  /* ---------- 描画操作 ---------- */
  cellAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.doc.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.doc.height);
    if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return null;
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
      if (this.drawing) {
        this.drawing = false;
        this.onChange(this.grid);
      }
    };
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
    if (this.hover) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(this.hover.x * z + 1, this.hover.y * z + 1, z - 2, z - 2);
    }
  }
}
