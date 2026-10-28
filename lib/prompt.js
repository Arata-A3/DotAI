// LLMへの指示文の組み立てと、返ってきたJSONのピクセル配列への正規化

export const INDEX_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const TRANSPARENT_CHAR = ".";
export const MAX_SIZE = 128;
export const MAX_COLORS = 32;
export const MAX_FRAMES = 8;

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    palette: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "string" } },
  },
  required: ["title", "palette", "rows"],
  additionalProperties: false,
};

export const ANIMATION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    palette: { type: "array", items: { type: "string" } },
    frames: { type: "array", items: { type: "array", items: { type: "string" } } },
  },
  required: ["title", "palette", "frames"],
  additionalProperties: false,
};

function systemPrompt(animation) {
  const pixelData = animation
    ? `- "frames": array of animation frames in playback order. Each frame is an array of strings, one per pixel row from top to bottom.`
    : `- "rows": array of strings, one per pixel row from top to bottom.`;
  return `You are a professional pixel artist. You create pixel art as exact data, pixel by pixel.

Output a JSON object:
- "title": short title of the image (in the user's language)
- "palette": array of colors as "#RRGGBB". Palette index i is written with the i-th character of "${INDEX_CHARS}".
${pixelData} Each character is one pixel: a palette index character, or "${TRANSPARENT_CHAR}" for a transparent pixel.

Hard rules:
- Exactly the requested number of rows, and every row exactly the requested width. Count carefully.
- Never use more palette colors than allowed.
- Use only palette index characters that exist in your palette, or "${TRANSPARENT_CHAR}".

Quality guidelines:
- Clear, readable silhouette that fills the canvas well (leave about 1px margin for sprites/icons).
- Use 2-3 tones per material (shadow, base, highlight) with a consistent light source from the top-left.
- Avoid noise, stray single pixels, and jagged lines; prefer clean pixel clusters.
- Small canvases (8-16px) need bold simplification; larger canvases can carry more detail.`;
}

function canvasLines({ width, height, maxColors, palette, style = {} }) {
  const lines = [];
  lines.push(`Canvas: width ${width} px, height ${height} px (so ${height} rows of ${width} characters).`);
  if (palette && palette.length) {
    lines.push(`Palette: use ONLY colors from this fixed palette (pick up to ${maxColors}): ${palette.join(", ")}.`);
  } else {
    lines.push(`Palette: at most ${maxColors} colors, chosen to suit the subject.`);
  }
  if (style.transparent) lines.push("Background: transparent (use \".\" for every background pixel).");
  else lines.push("Background: no transparent pixels; paint a background that fits the subject.");
  if (style.outline) lines.push("Give the subject a dark 1px outline.");
  if (style.tileable) lines.push("Make it a seamless tile: the left edge must continue into the right edge and the top edge into the bottom edge when repeated.");
  lines.push(style.dither ? "Dithering patterns are allowed for gradients." : "Do not use dithering; use flat color areas.");
  return lines;
}

export function buildPrompt(req) {
  const { prompt, style = {}, base, variation } = req;
  const lines = [`Request: ${prompt}`, ...canvasLines(req)];
  if (style.symmetry) lines.push("Make the image perfectly left-right symmetric.");
  if (variation && variation.total > 1) {
    lines.push(`This is variation ${variation.index} of ${variation.total}. Make it clearly different from the other variations (pose, design details, or color scheme) while still matching the request.`);
  }
  if (base) {
    lines.push("");
    lines.push("Modify the following existing image according to the request. Keep the same canvas size and keep everything the request does not ask to change.");
    lines.push(`Existing palette: ${JSON.stringify(base.palette)}`);
    lines.push("Existing rows:");
    lines.push(...base.rows);
  }
  return { system: systemPrompt(false), user: lines.join("\n"), schema: OUTPUT_SCHEMA };
}

// base（1コマ目）に続く frameCount-1 コマを作らせる
export function buildAnimationPrompt(req) {
  const { prompt, motion, frameCount, base } = req;
  const n = frameCount - 1;
  const lines = [
    `Create a looping pixel art animation of ${frameCount} frames in total. Motion: ${motion}`,
    prompt ? `Subject: ${prompt}` : "",
    `Frame 1 is the existing image below. Do NOT output frame 1; output exactly ${n} frame(s): frames 2 to ${frameCount}, in order, so that frames 1..${frameCount} play as a smooth loop back to frame 1.`,
    "Keep the subject's design, proportions and colors identical to frame 1, and keep it at the same position on the canvas unless the motion itself moves it. Change only what the motion requires.",
    "Reuse the existing palette in the same order; append new colors only if truly necessary.",
    ...canvasLines({ ...req, palette: [] }).filter((l) => !l.startsWith("Palette:")),
    "",
    `Existing palette: ${JSON.stringify(base.palette)}`,
    "Frame 1 rows:",
    ...base.rows,
  ];
  return { system: systemPrompt(true), user: lines.filter((l) => l !== "").join("\n"), schema: ANIMATION_SCHEMA };
}

// 現在のグリッド（pixels: インデックス配列、-1=透明）を rows 文字列に変換
export function gridToRows(grid) {
  const rows = [];
  for (let y = 0; y < grid.height; y++) {
    let s = "";
    for (let x = 0; x < grid.width; x++) {
      const v = grid.pixels[y * grid.width + x];
      s += v < 0 ? TRANSPARENT_CHAR : INDEX_CHARS[v] ?? TRANSPARENT_CHAR;
    }
    rows.push(s);
  }
  return rows;
}

function normalizeColor(c) {
  if (typeof c !== "string") return "#000000";
  let s = c.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split("").map((ch) => ch + ch).join("");
  if (/^[0-9a-fA-F]{8}$/.test(s)) s = s.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(s) ? "#" + s.toLowerCase() : "#000000";
}

function parseJson(text) {
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    throw new Error("LLMの出力をJSONとして読み取れませんでした");
  }
}

// rows を指定サイズのインデックス配列に揃える（はみ出しは切り捨て、不足は透明で埋める）
function rowsToPixels(rows, palette, width, height, warnings, label = "") {
  if (rows.length !== height) warnings.push(`${label}行数が${rows.length}でした（期待値${height}）`);
  const badWidth = rows.filter((r) => typeof r !== "string" || r.length !== width).length;
  if (badWidth) warnings.push(`${label}${badWidth}行の幅が${width}ではありませんでした`);
  const pixels = new Array(width * height).fill(-1);
  for (let y = 0; y < height; y++) {
    const row = typeof rows[y] === "string" ? rows[y] : "";
    for (let x = 0; x < width; x++) {
      const idx = INDEX_CHARS.indexOf(row[x]);
      pixels[y * width + x] = idx >= 0 && idx < palette.length ? idx : -1;
    }
  }
  return pixels;
}

export function parseOutput(text, width, height) {
  const data = parseJson(text);
  if (!Array.isArray(data.palette) || !Array.isArray(data.rows)) {
    throw new Error("LLMの出力に palette / rows がありません");
  }
  const palette = data.palette.slice(0, INDEX_CHARS.length).map(normalizeColor);
  const warnings = [];
  const pixels = rowsToPixels(data.rows, palette, width, height, warnings);
  return { title: String(data.title || ""), width, height, palette, pixels, warnings };
}

export function parseAnimationOutput(text, width, height, expectedFrames) {
  const data = parseJson(text);
  if (!Array.isArray(data.palette) || !Array.isArray(data.frames) || !data.frames.length) {
    throw new Error("LLMの出力に palette / frames がありません");
  }
  const palette = data.palette.slice(0, INDEX_CHARS.length).map(normalizeColor);
  const warnings = [];
  if (data.frames.length !== expectedFrames) warnings.push(`コマ数が${data.frames.length}でした（期待値${expectedFrames}）`);
  const frames = data.frames
    .slice(0, expectedFrames)
    .map((rows, i) => rowsToPixels(Array.isArray(rows) ? rows : [], palette, width, height, warnings, `${i + 2}コマ目: `));
  return { title: String(data.title || ""), width, height, palette, frames, warnings };
}
