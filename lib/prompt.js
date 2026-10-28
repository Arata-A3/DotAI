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

// "plan" を frames より先に書かせて、コマごとに何を動かすか決めてから描かせる（決めずに描くと1コマ目の丸写しになりやすい）
export const ANIMATION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    palette: { type: "array", items: { type: "string" } },
    plan: { type: "array", items: { type: "string" } },
    frames: { type: "array", items: { type: "array", items: { type: "string" } } },
  },
  required: ["title", "palette", "plan", "frames"],
  additionalProperties: false,
};

function systemPrompt(animation) {
  const pixelData = animation
    ? `- "plan": one short sentence per output frame saying exactly which parts move and by how many pixels compared with the previous frame.
- "frames": array of animation frames in playback order. Each frame is an array of strings, one per pixel row from top to bottom.`
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

// 同じプロンプトでも毎回・案ごとに違う絵になるよう、向きと色調だけをランダムに選んで添える
// （並列の案はお互いを知らないので「他の案と違えて」だけでは同じ絵に寄ってしまう。
//   ポーズや作風まで指定するとプロンプトとずれやすいので、絵の中身を変えない範囲にとどめる）
const DIRECTIONS = {
  view: ["front view", "three-quarter view facing left", "three-quarter view facing right"],
  mood: ["slightly warm color balance", "slightly cool color balance", "a bit more contrast", "a bit softer tones"],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function directionLine(req) {
  const d = [];
  // 左右対称の指定があるときは、斜めにならないよう向きは指定しない
  if (!req.style?.symmetry) d.push(pick(DIRECTIONS.view));
  // パレットが決まっているときは色調の指定はしない
  if (!req.palette?.length) d.push(pick(DIRECTIONS.mood));
  if (!d.length) return "";
  return `Minor preference for this attempt, only where the request leaves it open (the request always takes priority): ${d.join("; ")}.`;
}

export function buildPrompt(req) {
  const { prompt, style = {}, base, variation } = req;
  const lines = [`Request: ${prompt}`, ...canvasLines(req)];
  if (style.symmetry) lines.push("Make the image perfectly left-right symmetric.");
  const direction = base ? "" : directionLine(req);
  if (direction) lines.push(direction);
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

// よく使う動きのキーポーズ（1周分）。コマ数に合わせて選び、コマごとの具体的な指示にする
// （「歩く」だけだと何をどれだけ動かすか決めきれず、ほとんど動かない・崩れるといった結果になりやすい）
const MOTION_GUIDES = [
  { match: /歩|walk/i, poses: [
    "contact pose: left leg stepped forward, right leg back, right arm forward, left arm back",
    "passing pose: legs together under the body, whole body 1px higher",
    "contact pose: right leg stepped forward, left leg back, left arm forward, right arm back",
    "passing pose: legs together under the body, whole body 1px higher",
  ] },
  { match: /走|run|dash/i, poses: [
    "stride: left leg far forward, right leg far back, body leaning forward, arms swinging wide",
    "airborne: both feet off the ground, legs tucked, body 1px higher",
    "stride: right leg far forward, left leg far back, body leaning forward, arms swinging wide",
    "airborne: both feet off the ground, legs tucked, body 1px higher",
  ] },
  { match: /待機|呼吸|idle|breath/i, poses: [
    "neutral pose, exactly as frame 1",
    "breathing out: head and torso 1px lower, shoulders slightly down (feet stay put)",
  ] },
  { match: /ジャンプ|跳|jump/i, poses: [
    "neutral pose, exactly as frame 1",
    "crouch: body 2px lower, knees bent, arms down",
    "airborne: whole body 3-4px higher than frame 1, legs tucked, arms up",
    "landing: body 1px lower, slight squash, arms out",
  ] },
  { match: /攻撃|斬|attack|slash/i, poses: [
    "ready pose, exactly as frame 1",
    "wind-up: weapon or arm raised high behind the body",
    "strike: weapon or arm swung fully forward, body leaning in, with a small motion arc",
    "follow-through: weapon or arm low and forward, returning to the ready pose",
  ] },
  { match: /ダメージ|のけぞ|hurt|damage|hit/i, poses: [
    "neutral pose, exactly as frame 1",
    "recoil: head and torso leaning back by 2px, eyes squeezed shut",
    "recovering: leaning back by 1px",
  ] },
  { match: /揺れ|ゆらゆら|sway|wobble/i, poses: [
    "neutral, exactly as frame 1",
    "top part leaning 1-2px to the left",
    "neutral",
    "top part leaning 1-2px to the right",
  ] },
  { match: /光|きらめ|輝|glow|sparkle|shine/i, poses: [
    "normal brightness, exactly as frame 1",
    "highlights brighter, 2-3 small sparkle pixels appear around the subject",
    "brightest: sparkles larger and spread outward",
    "sparkles fading, highlights back to normal",
  ] },
  { match: /回転|rotat|spin/i, poses: [
    "facing the front, exactly as frame 1",
    "turned a quarter: seen from the side, narrower silhouette",
    "turned half: seen from the back",
    "turned three quarters: seen from the other side",
  ] },
  { match: /作業|組み立て|組立|工場|製造|手作業|work|assembl|craft/i, poses: [
    "working pose as in frame 1: leaning slightly over the work, hands on the workpiece",
    "reaching: one arm extended to pick up a part or tool, torso turned slightly toward it",
    "fitting: both hands bring the part onto the workpiece, head tilted down toward the hands",
    "fastening: one hand pressed on the workpiece, the other hand (with a tool) moved 1-2px as if screwing or tapping",
  ].map((p) => `${p}; legs and feet stay exactly as in frame 1`) },
  { match: /炎|火|flame|fire/i, poses: [
    "flame as in frame 1",
    "flame tips taller and shifted 1px to the left, inner core shape changed",
    "flame tips shorter and wider",
    "flame tips taller and shifted 1px to the right",
  ] },
  { match: /水|波|wave|water/i, poses: [
    "waves as in frame 1",
    "every wave crest and highlight shifted a quarter of the wave length to the right",
    "every wave crest and highlight shifted half the wave length to the right",
    "every wave crest and highlight shifted three quarters of the wave length to the right",
  ] },
];

export const hasMotionGuide = (motion) => MOTION_GUIDES.some((g) => g.match.test(motion));

// 2コマ目以降のポーズ（frameCount-1 個）。plan（AIに先に考えさせた全コマ分のポーズ）があればそれを使い、
// なければ用意したキーポーズから、1周を等分して選ぶ（間に当たるコマは「AとBの中間」にする）。どちらもなければ []
export function framePoses(motion, frameCount, plan) {
  if (plan?.length >= frameCount) return plan.slice(1, frameCount);
  const guide = MOTION_GUIDES.find((g) => g.match.test(motion));
  if (!guide) return [];
  const k = guide.poses.length;
  const poses = [];
  for (let i = 1; i < frameCount; i++) {
    const t = (i * k) / frameCount;
    const a = Math.floor(t) % k;
    poses.push(Number.isInteger(t) ? guide.poses[a] : `in between "${guide.poses[a]}" and "${guide.poses[(a + 1) % k]}"`);
  }
  return poses;
}

function motionPlanLines(motion, frameCount, plan) {
  const poses = framePoses(motion, frameCount, plan);
  if (!poses.length) return [];
  return ["Key pose for each frame (frame 1 is the first pose; adapt to the subject):", ...poses.map((p, i) => `- Frame ${i + 2}: ${p}`)];
}

// 1コマだけを描かせる。全コマを1回で出させると1コマ目の丸写しになりやすいので、
// コマごとに「1コマ目を、このポーズで描き直す」と頼む（各コマは独立しているので並列に呼べる）
export function buildFramePrompt(req, frameNo, pose, retry = false) {
  const { prompt, motion, frameCount, base, stillParts } = req;
  const lines = [
    `Draw frame ${frameNo} of a ${frameCount}-frame looping pixel art animation. Motion: ${motion}`,
    prompt ? `Subject: ${prompt}` : "",
    `Frame 1 is the existing image below. Redraw the same subject in this pose: ${pose}`,
    "The pose must express the requested motion above; if the pose description seems to conflict with it, follow the requested motion.",
    "Keep the design, proportions, colors, size and position identical to frame 1, except for the parts this pose moves.",
    stillParts ? `These parts must stay exactly as in frame 1, pixel for pixel (do not move them at all): ${stillParts}` : "",
    "The pose change must be clearly visible: redraw the moving parts in their new place, shifted by 2-3 pixels or more. Do not output frame 1 unchanged.",
    retry ? "Your previous attempt was almost identical to the neighboring frame. That is wrong. Move the parts much more clearly this time." : "",
    "Reuse the existing palette in the same order; append new colors only if truly necessary.",
    ...canvasLines({ ...req, palette: [] }).filter((l) => !l.startsWith("Palette:")),
    "",
    `Existing palette: ${JSON.stringify(base.palette)}`,
    "Frame 1 rows:",
    ...base.rows,
  ];
  return { system: systemPrompt(false), user: lines.filter((l) => l !== "").join("\n"), schema: OUTPUT_SCHEMA };
}

// パレットが別々のコマを、共通パレット（先頭は seed の並び）にまとめる
export function mergeFrames(grids, seed = []) {
  const palette = [...seed];
  const index = new Map(palette.map((c, i) => [c, i]));
  const frames = grids.map((g) => g.pixels.map((v) => {
    if (v < 0) return -1;
    const c = g.palette[v];
    if (!index.has(c)) index.set(c, palette.push(c) - 1);
    return index.get(c);
  }));
  return { palette, frames };
}

// 動かさない行（{ from, to }、0始まり）を、全コマで1コマ目と同じにする。
// 手作業なのに足まで動いて踊っているように見える、といったことを指示だけに頼らず防ぐ
// （merged は mergeFrames(…, base.palette) の結果なので、base のインデックスをそのまま使える）
export function lockRows(merged, base, rows) {
  if (!rows) return merged;
  const w = base.width;
  const frames = merged.frames.map((f) => {
    const out = [...f];
    for (let y = rows.from; y <= rows.to; y++) {
      for (let x = 0; x < w; x++) out[y * w + x] = base.pixels[y * w + x];
    }
    return out;
  });
  return { ...merged, frames };
}

// 描く前に全コマ分のポーズと、動かさない部分をAIに文章で決めさせる（絵を出させるより軽く、動きの筋が通りやすい）
// 項目の順番どおりに出力されるので、先に「動かさない部分」を決めさせてからポーズを考えさせる
export const MOTION_PLAN_SCHEMA = {
  type: "object",
  properties: {
    still_parts: { type: "string" },
    still_rows: { type: "string" },
    poses: { type: "array", items: { type: "string" } },
  },
  required: ["still_parts", "still_rows", "poses"],
  additionalProperties: false,
};

export function buildMotionPlanPrompt({ prompt, motion, frameCount, base, width, height }) {
  const system = `You are a pixel art animator. You plan looping sprite animations as key poses before they are drawn.
Output a JSON object:
- "still_parts": the body parts or objects that must NOT move at all during this motion (short phrase), or "" if everything moves.
  Only move what the motion needs. For example, hand work such as assembling, typing or cooking moves only the arms, hands, tools and maybe the head; the legs, feet and lower body stay completely still.
- "still_rows": the row numbers (1 = top row) that contain only still parts, as "from-to" (e.g. "22-32"), or "" if none. Never include a row where anything moves.
- "poses": exactly the requested number of strings, one per frame in playback order.
  Each string is one concrete sentence naming which body parts or objects move, in which direction, and by about how many pixels compared with frame 1.
Frame 1 is the existing image as it is. The last frame must lead smoothly back to frame 1.
Follow the user's motion description faithfully: animate exactly the action they asked for, never substitute a different action.
Make the motion clearly readable at pixel art scale: moving parts should shift 1-3 pixels between frames.
Write "still_parts" and each pose in the same language as the user's motion description.`;
  // 用意したキーポーズは参考として渡すだけにする（そのまま使うと、ユーザーの書いた動きや絵の構図とずれることがある）
  const hint = framePoses(motion, frameCount);
  const user = [
    `Motion requested by the user: ${motion}`,
    prompt ? `Subject: ${prompt}` : "",
    hint.length ? `Generic reference for this kind of motion (use only the parts that fit the user's request and this image): ${hint.map((p, i) => `frame ${i + 2}: ${p}`).join(" / ")}` : "",
    `Plan exactly ${frameCount} frames for a ${width}x${height} px sprite. Look at frame 1 below to see where the head, hands, tools and other parts are.`,
    `Palette: ${JSON.stringify(base.palette)} ("${TRANSPARENT_CHAR}" = transparent)`,
    "Frame 1 rows (row number: pixels):",
    ...base.rows.map((r, i) => `${i + 1}: ${r}`),
  ].filter((l) => l !== "").join("\n");
  return { system, user, schema: MOTION_PLAN_SCHEMA };
}

// { poses, stillParts, stillRows: { from, to }（0始まり） | null }
// 動かさない行が全体の7割を超えるときは、読み違いの可能性が高いので使わない
export function parseMotionPlan(text, height) {
  const data = parseJson(text);
  const poses = Array.isArray(data.poses) ? data.poses.filter((p) => typeof p === "string" && p.trim()) : [];
  const stillParts = typeof data.still_parts === "string" ? data.still_parts.trim() : "";
  const m = String(data.still_rows ?? "").match(/(\d+)\s*[-–~〜]\s*(\d+)/);
  let stillRows = null;
  if (m) {
    const from = Math.max(1, +m[1]) - 1;
    const to = Math.min(height, +m[2]) - 1;
    if (from <= to && to - from + 1 <= height * 0.7) stillRows = { from, to };
  }
  return { poses, stillParts, stillRows };
}

// base（1コマ目）に続く frameCount-1 コマを作らせる
export function buildAnimationPrompt(req) {
  const { prompt, motion, frameCount, base, retry, plan } = req;
  const n = frameCount - 1;
  const lines = [
    `Create a looping pixel art animation of ${frameCount} frames in total. Motion: ${motion}`,
    prompt ? `Subject: ${prompt}` : "",
    `Frame 1 is the existing image below. Do NOT output frame 1; output exactly ${n} frame(s): frames 2 to ${frameCount}, in order, so that frames 1..${frameCount} play as a smooth loop back to frame 1.`,
    "Keep the subject's design, proportions and colors identical to frame 1, and keep it at the same position on the canvas unless the motion itself moves it.",
    "But the motion must be clearly visible: every frame MUST differ from the previous frame, with the moving parts shifted or redrawn by at least 1-2 pixels. Never output a copy of frame 1 or of the previous frame.",
    "Write the plan first, then draw each frame following its plan.",
    ...motionPlanLines(motion, frameCount, plan),
    retry ? `Your previous answer barely moved (${retry}). That is wrong. This time, clearly move the parts described in the plan.` : "",
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

// 前のコマ（2コマ目の前は base）からほとんど変わっていないコマの番号（2始まり）を返す。
// パレットの並びが違っても色で比べる。変わったのが描かれている部分の3%未満（最低3px）なら「動いていない」とみなす
export function findStillFrames(base, result) {
  const colorsOf = (pixels, palette) => pixels.map((v) => (v < 0 ? "" : palette[v]));
  const minChange = Math.max(3, Math.ceil(base.pixels.filter((v) => v >= 0).length * 0.03));
  let prev = colorsOf(base.pixels, base.palette);
  const still = [];
  result.frames.forEach((f, i) => {
    const cur = colorsOf(f, result.palette);
    if (cur.filter((c, j) => c !== prev[j]).length < minChange) still.push(i + 2);
    prev = cur;
  });
  return still;
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
