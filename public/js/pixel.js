// グリッド = { width, height, palette: ["#rrggbb"...], pixels: [index or -1(透明)] } に対する加工処理

export const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function dist(a, b) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  // 人の目の感度を考慮した簡易重み付き距離
  return 2 * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + 3 * (b1 - b2) ** 2;
}

export const cloneGrid = (g) => ({ ...g, palette: [...g.palette], pixels: [...g.pixels] });

/* ---------- 複数コマ = doc { width, height, palette(全コマ共通), frames: [pixels...], fps } ---------- */

export const cloneDoc = (d) => ({ ...d, palette: [...d.palette], frames: d.frames.map((f) => [...f]) });

export const frameGrid = (d, i) => ({ width: d.width, height: d.height, palette: d.palette, pixels: d.frames[i] });

// 全コマを縦に積んだ1枚のグリッドにする（減色など位置に依存しない処理を全コマ共通で行うため）
export const stackFrames = (d) => ({
  width: d.width, height: d.height * d.frames.length, palette: [...d.palette], pixels: d.frames.flat(),
});

export function unstackFrames(g, d) {
  const size = d.width * d.height;
  return { ...d, palette: g.palette, frames: d.frames.map((_, i) => g.pixels.slice(i * size, (i + 1) * size)) };
}

// 各コマに順番に処理を適用（パレットは引き継ぐ。インデックスを並べ替える処理には使わないこと）
export function mapFrames(d, fn) {
  let { palette, width, height } = d;
  const frames = d.frames.map((pixels) => {
    const g = fn({ width: d.width, height: d.height, palette, pixels });
    ({ palette, width, height } = g);
    return g.pixels;
  });
  return { ...d, width, height, palette: [...palette], frames };
}

// パレットが別々のグリッド群を、共通パレットの doc にまとめる
export function gridsToDoc(grids, fps = 8) {
  const palette = [];
  const index = new Map();
  const frames = grids.map((g) => g.pixels.map((v) => {
    if (v < 0) return -1;
    const c = g.palette[v];
    if (!index.has(c)) index.set(c, palette.push(c) - 1);
    return index.get(c);
  }));
  return { width: grids[0].width, height: grids[0].height, palette, frames, fps };
}

export function emptyGrid(width, height) {
  return { width, height, palette: ["#000000", "#ffffff"], pixels: new Array(width * height).fill(-1) };
}

// 使われていない色を削除し、同じ色をまとめてインデックスを詰める
export function compactPalette(g) {
  const map = new Map();
  const palette = [];
  const remap = g.palette.map((c) => {
    if (!map.has(c)) {
      map.set(c, palette.length);
      palette.push(c);
    }
    return map.get(c);
  });
  const used = new Set(g.pixels.filter((v) => v >= 0).map((v) => remap[v]));
  const finalIdx = [];
  const finalPal = [];
  palette.forEach((c, i) => {
    if (used.has(i)) {
      finalIdx[i] = finalPal.length;
      finalPal.push(c);
    }
  });
  return { ...g, palette: finalPal, pixels: g.pixels.map((v) => (v < 0 ? -1 : finalIdx[remap[v]])) };
}

// 全色を固定パレットの最も近い色に置き換える
export function mapToPalette(g, colors) {
  if (!colors.length) return g;
  const remap = g.palette.map((c) => {
    let best = 0;
    colors.forEach((p, i) => {
      if (dist(c, p) < dist(c, colors[best])) best = i;
    });
    return best;
  });
  return compactPalette({ ...g, palette: [...colors], pixels: g.pixels.map((v) => (v < 0 ? -1 : remap[v])) });
}

// 色数が上限を超えていたら、最も近い2色を（使用数の多い方へ）統合していく
export function reduceColors(g, max) {
  let cur = compactPalette(g);
  while (cur.palette.length > max) {
    const counts = cur.palette.map(() => 0);
    cur.pixels.forEach((v) => v >= 0 && counts[v]++);
    let best = [0, 1];
    let bestD = Infinity;
    for (let i = 0; i < cur.palette.length; i++) {
      for (let j = i + 1; j < cur.palette.length; j++) {
        const d = dist(cur.palette[i], cur.palette[j]);
        if (d < bestD) [bestD, best] = [d, [i, j]];
      }
    }
    const [keep, drop] = counts[best[0]] >= counts[best[1]] ? best : [best[1], best[0]];
    cur = compactPalette({ ...cur, pixels: cur.pixels.map((v) => (v === drop ? keep : v)) });
  }
  return cur;
}

// 左半分を右半分へ鏡写し
export function mirrorLeftToRight(g) {
  const out = cloneGrid(g);
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < Math.floor(g.width / 2); x++) {
      out.pixels[y * g.width + (g.width - 1 - x)] = g.pixels[y * g.width + x];
    }
  }
  return out;
}

export function flipHorizontal(g) {
  const out = cloneGrid(g);
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) out.pixels[y * g.width + x] = g.pixels[y * g.width + (g.width - 1 - x)];
  }
  return out;
}

// 不透明ピクセルの外側（上下左右に接する透明ピクセル）に輪郭線を付ける
export function addOutline(g, color = null) {
  const out = cloneGrid(g);
  let c = color;
  if (!c) {
    // 既存パレットの最も暗い色を使う
    c = g.palette.reduce((a, b) => (hexToRgb(b).reduce((s, v) => s + v) < hexToRgb(a).reduce((s, v) => s + v) ? b : a), "#ffffff");
  }
  let idx = out.palette.indexOf(c);
  if (idx < 0) idx = out.palette.push(c) - 1;
  const { width: w, height: h } = g;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g.pixels[y * w + x] >= 0) continue;
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < w && ny < h && g.pixels[ny * w + nx] >= 0;
      });
      if (near) out.pixels[y * w + x] = idx;
    }
  }
  return out;
}

// 画像の外周と同じ色でつながった領域を透明にする（背景除去）
export function removeBackground(g) {
  const out = cloneGrid(g);
  const { width: w, height: h } = g;
  const corners = [0, w - 1, (h - 1) * w, h * w - 1].map((i) => g.pixels[i]);
  const counts = {};
  corners.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
  const bg = +Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  if (bg < 0) return out;
  const stack = [];
  for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1]);
  for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y]);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (out.pixels[i] !== bg) continue;
    out.pixels[i] = -1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}

// サイズ変更（最近傍補間）
export function resize(g, width, height) {
  const pixels = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x * g.width) / width);
      const sy = Math.floor((y * g.height) / height);
      pixels[y * width + x] = g.pixels[sy * g.width + sx];
    }
  }
  return { ...g, width, height, palette: [...g.palette], pixels };
}

// 指定倍率で描いたcanvasを返す
export function renderToCanvas(g, scale = 1) {
  const c = document.createElement("canvas");
  c.width = g.width * scale;
  c.height = g.height * scale;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(g.width, g.height);
  const rgb = g.palette.map(hexToRgb);
  g.pixels.forEach((v, i) => {
    if (v < 0) return;
    img.data.set([...rgb[v], 255], i * 4);
  });
  if (scale === 1) {
    ctx.putImageData(img, 0, 0);
  } else {
    const tmp = document.createElement("canvas");
    tmp.width = g.width;
    tmp.height = g.height;
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, c.width, c.height);
  }
  return c;
}

// スプライトシート（cols 列で折り返し。0以下なら横一列）
export function renderSheet(d, cols, scale = 1) {
  const n = d.frames.length;
  const c = cols > 0 ? Math.min(cols, n) : n;
  const rows = Math.ceil(n / c);
  const out = document.createElement("canvas");
  out.width = d.width * c * scale;
  out.height = d.height * rows * scale;
  const ctx = out.getContext("2d");
  d.frames.forEach((_, i) => {
    ctx.drawImage(renderToCanvas(frameGrid(d, i), scale), (i % c) * d.width * scale, Math.floor(i / c) * d.height * scale);
  });
  return out;
}

// PNG画像ファイルを読み込んでグリッド化（インポート用）
export async function imageToGrid(file, width, height, maxColors) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const build = (quantize) => {
    const palette = [];
    const index = new Map();
    const pixels = [];
    for (let i = 0; i < width * height; i++) {
      if (data[i * 4 + 3] < 128) {
        pixels.push(-1);
        continue;
      }
      const hex = "#" + [0, 1, 2].map((k) => quantize(data[i * 4 + k]).toString(16).padStart(2, "0")).join("");
      if (!index.has(hex)) index.set(hex, palette.push(hex) - 1);
      pixels.push(index.get(hex));
    }
    return { width, height, palette, pixels };
  };
  let g = build((v) => v);
  // 色が多すぎる写真等は、減色処理が重くならないよう先に粗く量子化する
  if (g.palette.length > 64) g = build((v) => Math.min(255, Math.round(v / 36) * 36));
  return reduceColors(g, maxColors);
}
