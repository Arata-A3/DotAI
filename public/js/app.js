import { PALETTES, TEMPLATES, SIZE_PRESETS } from "./data.js";
import * as px from "./pixel.js";
import { encodeGif } from "./gif.js";
import { Editor } from "./editor.js";

const $ = (id) => document.getElementById(id);
const el = (tag, { dataset, ...props } = {}, children = []) => {
  const e = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(e.dataset, dataset);
  e.append(...children);
  return e;
};

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const storage = {
  get(k, def) {
    try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

// 現在キャンバスにある絵の情報（履歴IDやプロンプト）
let current = { id: null, title: "", prompt: "" };
let settings = null;
let candidates = [];
let previewVersion = 0;

/* ---------- エディタ ---------- */
const editor = new Editor($("canvas"), {
  onChange: () => {
    renderEditorPalette();
    renderFrameStrip();
    previewVersion++;
    updateInfo();
  },
  // 消しゴム中に右クリックで色を拾ったら、そのまま描けるようペンに切り替える
  onPick: () => {
    if (editor.tool === "eraser") setTool("pen");
    renderEditorPalette();
  },
  // タイトルや履歴IDも Undo/Redo で絵と一緒に戻す（戻したあとの上書き保存で別の絵を消さないため）
  getMeta: () => ({ ...current }),
  setMeta: (m) => {
    current = { ...m };
    renderHistoryHighlight();
    renderCandidates();
  },
});

function updateInfo() {
  const d = editor.doc;
  if (!d) return;
  const parts = [`${d.width}×${d.height}`, `${d.palette.length}色`, `表示 ×${editor.zoom}`];
  if (d.frames.length > 1) parts.push(`コマ ${editor.frame + 1}/${d.frames.length}`);
  $("canvasInfo").textContent = parts.join(" / ");
  // 入力中は書き換えない
  if (document.activeElement !== $("titleInput")) $("titleInput").value = current.title || "";
}

// 名前の変更。履歴に保存済みなら履歴の名前だけ変える（絵の内容は上書きしない）
$("titleInput").addEventListener("change", async () => {
  current.title = $("titleInput").value.trim();
  if (!current.id) return;
  try {
    await api(`/api/history/${current.id}`, { method: "PATCH", body: { title: current.title } });
    await loadHistory();
  } catch (err) {
    setStatus(err.message, "error");
  }
});
$("titleInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});

function renderEditorPalette() {
  const g = editor.grid;
  const box = $("editorPalette");
  box.replaceChildren();
  g.palette.forEach((c, i) => {
    const s = el("div", { className: "swatch" + (i === editor.color ? " selected" : ""), title: c });
    s.style.background = c;
    s.onclick = () => {
      editor.color = i;
      if (editor.tool === "eraser" || editor.tool === "picker") setTool("pen");
      renderEditorPalette();
    };
    box.append(s);
  });
  $("colorEdit").value = g.palette[editor.color] || "#000000";
}

$("colorEdit").addEventListener("input", (e) => {
  const d = editor.doc;
  if (!d.palette.length) return;
  d.palette[editor.color] = e.target.value;
  editor.render();
  previewVersion++;
  renderEditorPalette();
});
$("colorEdit").addEventListener("change", renderFrameStrip);
// 色編集の前の状態をUndo履歴へ積む
$("colorEdit").addEventListener("focus", () => editor.pushUndo());

$("addColor").onclick = () => {
  editor.applyDoc((d) => ({ ...d, palette: [...d.palette, $("colorEdit").value] }));
  editor.color = editor.doc.palette.length - 1;
  renderEditorPalette();
};

function setTool(t) {
  editor.cancelShape();
  editor.tool = t;
  document.querySelectorAll("#tools button").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
}
document.querySelectorAll("#tools button").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

$("mirrorDraw").onclick = () => {
  editor.mirror = !editor.mirror;
  $("mirrorDraw").classList.toggle("active", editor.mirror);
  editor.render();
};
$("toggleGrid").onclick = () => {
  editor.showGrid = !editor.showGrid;
  $("toggleGrid").classList.toggle("active", editor.showGrid);
  editor.render();
};
$("zoomIn").onclick = () => { editor.setZoom(editor.zoom + Math.max(1, Math.round(editor.zoom * 0.25))); updateInfo(); };
$("zoomOut").onclick = () => { editor.setZoom(editor.zoom - Math.max(1, Math.round(editor.zoom * 0.2))); updateInfo(); };
$("undo").onclick = () => editor.undo();
$("redo").onclick = () => editor.redo();

document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if (k === "escape") {
    editor.cancelShape();
    closeMenus();
    return;
  }
  if (editor.shape && k === "enter") return editor.finishShape();
  if (editor.shape && k === "backspace") {
    e.preventDefault();
    return editor.removeShapePoint();
  }
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); editor.redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const arrows = { arrowup: "shiftUp", arrowdown: "shiftDown", arrowleft: "shiftLeft", arrowright: "shiftRight" };
  if (arrows[k] && !editor.shape) {
    e.preventDefault();
    return runOp(arrows[k]);
  }
  const map = { b: "pen", e: "eraser", g: "fill", i: "picker", l: "line", c: "curve" };
  if (map[k]) setTool(map[k]);
  if (k === "m") $("mirrorDraw").click();
  if (k === ",") editor.setFrame(editor.frame - 1);
  if (k === ".") editor.setFrame(editor.frame + 1);
});

/* ---------- メニュー ---------- */
function closeMenus() {
  document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
}
document.querySelectorAll(".menu").forEach((m) => {
  m.querySelector(".menu-btn").onclick = (e) => {
    e.stopPropagation();
    const open = !m.classList.contains("open");
    closeMenus();
    m.classList.toggle("open", open);
  };
  // 項目を選んだら閉じる（チェックボックスは除く）
  m.querySelector(".menu-list").addEventListener("click", (e) => {
    if (e.target.closest("button, .menu-item:not(.check)")) closeMenus();
  });
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu")) closeMenus();
});

/* ---------- マウスオーバー説明（要素の上側に出してカーソルで隠れないようにする） ---------- */
const tip = $("tooltip");
let tipTarget = null;
let tipTimer = null;
function hideTip() {
  clearTimeout(tipTimer);
  tip.hidden = true;
  tipTarget = null;
}
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest("[title], [data-tip]");
  if (t === tipTarget) return;
  hideTip();
  if (!t) return;
  // ブラウザ標準のツールチップ（カーソルの下に出る）を止めて自前で表示する
  if (t.hasAttribute("title")) {
    t.dataset.tip = t.title;
    t.removeAttribute("title");
  }
  if (!t.dataset.tip) return;
  tipTarget = t;
  tipTimer = setTimeout(() => {
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const r = t.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = r.top - tr.height - 6;
    if (top < 4) top = r.bottom + 6;
    const left = Math.min(window.innerWidth - tr.width - 4, Math.max(4, r.left + r.width / 2 - tr.width / 2));
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }, 350);
});
document.addEventListener("mousedown", hideTip);

/* ---------- コマ ---------- */
function renderFrameStrip() {
  const d = editor.doc;
  const box = $("frameList");
  box.replaceChildren();
  d.frames.forEach((_, i) => {
    const item = el("div", { className: "frame" + (i === editor.frame ? " current" : ""), title: `${i + 1}コマ目` }, [
      px.renderToCanvas(px.frameGrid(d, i), 1),
      el("span", { textContent: i + 1 }),
    ]);
    item.onclick = () => editor.setFrame(i);
    box.append(item);
  });
  box.querySelector(".current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  $("fps").value = d.fps || 8;
  $("deleteFrame").disabled = d.frames.length <= 1;
}
$("addFrame").onclick = () => editor.addFrame(true);
$("addEmptyFrame").onclick = () => editor.addFrame(false);
$("deleteFrame").onclick = () => editor.deleteFrame();
$("moveFrameLeft").onclick = () => editor.moveFrame(-1);
$("moveFrameRight").onclick = () => editor.moveFrame(1);
$("onion").onclick = () => {
  editor.onion = !editor.onion;
  $("onion").classList.toggle("active", editor.onion);
  editor.render();
};
$("fps").addEventListener("input", () => {
  editor.doc.fps = Math.min(30, Math.max(1, +$("fps").value || 8));
  previewVersion++;
});

/* ---------- 加工 ---------- */
// 色のインデックスを並べ替える処理は、全コマを縦に積んでまとめて行う
const stacked = (fn) => (d) => px.unstackFrames(fn(px.stackFrames(d)), d);

const FRAME_OPS = {
  mirror: px.mirrorLeftToRight,
  flip: px.flipHorizontal,
  flipV: px.flipVertical,
  shiftUp: (g) => px.shift(g, 0, -1),
  shiftDown: (g) => px.shift(g, 0, 1),
  shiftLeft: (g) => px.shift(g, -1, 0),
  shiftRight: (g) => px.shift(g, 1, 0),
  outline: (g) => px.addOutline(g),
  removeBg: px.removeBackground,
};
const DOC_OPS = {
  reduce: stacked((g) => px.reduceColors(g, +$("maxColors").value)),
  mapPalette: (d) => {
    const colors = selectedPaletteColors();
    if (!colors.length) {
      setStatus("「おまかせ」以外のパレットを選んでください", "error");
      return d;
    }
    return stacked((g) => px.mapToPalette(g, colors))(d);
  },
  // 回転は幅と高さが変わるので、コマごとにサイズがずれないよう常に全コマへ適用
  rotateCw: (d) => px.mapFrames(d, (g) => px.rotate90(g, true)),
  rotateCcw: (d) => px.mapFrames(d, (g) => px.rotate90(g, false)),
  resize: (d) => {
    const { width, height } = readSize();
    return px.mapFrames(d, (g) => px.resize(g, width, height));
  },
};
function runOp(op) {
  if (DOC_OPS[op]) editor.applyDoc(DOC_OPS[op]);
  else if ($("opAllFrames").checked) editor.applyDoc((d) => px.mapFrames(d, FRAME_OPS[op]));
  else editor.apply(FRAME_OPS[op]);
}
document.querySelectorAll("[data-op]").forEach((b) => (b.onclick = () => runOp(b.dataset.op)));
$("cleanPalette").onclick = () => editor.applyDoc(stacked(px.compactPalette));

$("newCanvas").onclick = () => {
  const { width, height } = readSize();
  const colors = selectedPaletteColors();
  const g = px.emptyGrid(width, height);
  if (colors.length) g.palette = [...colors];
  editor.setGrid(g, { meta: { id: null, title: "", prompt: "" } });
};

// 画像を読み込むときのサイズの決め方（設定画面で選択）
const IMPORT_MODES = {
  fit: "比率を保って収める（余白は透明）",
  stretch: "今のサイズ設定に引き伸ばす（比率は変わる）",
  original: "元の画像サイズのまま（最大128px）",
};
const importMode = () => {
  const m = storage.get("dotai.importMode", "fit");
  return IMPORT_MODES[m] ? m : "fit";
};

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const { width, height } = readSize();
  const mode = importMode();
  const g = await px.imageToGrid(file, width, height, +$("maxColors").value, mode);
  editor.setGrid(g, { meta: { id: null, title: file.name.replace(/\.\w+$/, ""), prompt: "" } });
  e.target.value = "";
  setStatus(`${file.name} を ${g.width}×${g.height}（${IMPORT_MODES[mode]}）で読み込みました`);
});

/* ---------- プレビュー（複数コマなら再生） ---------- */
let previewKey = "";
function drawPreview(frameIndex) {
  const d = editor.doc;
  const reps = $("tilePreviewToggle").checked ? 3 : 1;
  const base = px.renderToCanvas(px.frameGrid(d, frameIndex), 1);
  const scale = Math.max(1, Math.floor(260 / (Math.max(d.width, d.height) * reps)));
  const c = $("preview");
  c.width = d.width * reps * scale;
  c.height = d.height * reps * scale;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, c.width, c.height);
  for (let y = 0; y < reps; y++) {
    for (let x = 0; x < reps; x++) ctx.drawImage(base, x * d.width * scale, y * d.height * scale, d.width * scale, d.height * scale);
  }
}
function previewLoop() {
  const d = editor.doc;
  if (d) {
    const n = d.frames.length;
    const idx = n > 1 ? Math.floor(performance.now() / (1000 / (d.fps || 8))) % n : 0;
    const key = `${idx}|${previewVersion}`;
    if (key !== previewKey) {
      previewKey = key;
      drawPreview(idx);
    }
  }
  requestAnimationFrame(previewLoop);
}
$("tilePreviewToggle").addEventListener("change", () => previewVersion++);

/* ---------- 生成フォーム ---------- */
function setStatus(msg, kind = "") {
  const s = $("status");
  s.textContent = msg;
  s.className = "status " + kind;
}

function renderTemplateSelect() {
  $("template").replaceChildren(...TEMPLATES.map((t) => el("option", { value: t.id, textContent: t.label })));
}

function currentTemplate() {
  return TEMPLATES.find((t) => t.id === $("template").value) || TEMPLATES[0];
}

function renderTemplateFields(applySettings) {
  const t = currentTemplate();
  const box = $("templateFields");
  box.replaceChildren();
  for (const f of t.fields) {
    const input = el("input", { type: "text", placeholder: f.placeholder, dataset: { key: f.key } });
    if (f.options) {
      const listId = `opts-${t.id}-${f.key}`;
      input.setAttribute("list", listId);
      box.append(el("datalist", { id: listId }, f.options.map((o) => el("option", { value: o }))));
    }
    input.addEventListener("input", composePrompt);
    box.append(el("label", { textContent: f.label }, [input]));
  }
  if (applySettings) {
    const s = t.settings;
    if (s.size) setSize(s.size, s.size);
    const flags = { transparent: "stTransparent", symmetry: "stSymmetry", outline: "stOutline", tileable: "stTileable" };
    for (const [k, id] of Object.entries(flags)) if (k in s) $(id).checked = s[k];
  }
  composePrompt();
}

// 空欄の項目を含む部分は省く（入力例 placeholder はプロンプトに入れない）
function composePrompt() {
  const t = currentTemplate();
  if (!t.fields.length) return;
  const values = {};
  document.querySelectorAll("#templateFields input").forEach((i) => (values[i.dataset.key] = i.value.trim()));
  const fill = (part) => {
    const keys = [...part.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    return keys.every((k) => values[k]) ? part.replace(/\{(\w+)\}/g, (_, k) => values[k]) : null;
  };
  const text = t.parts.map((p) => (Array.isArray(p) ? p.map(fill).find((v) => v !== null) : fill(p)) ?? "").join("");
  $("prompt").value = text.replace(/、。/g, "。").replace(/。+/g, "。");
}

$("template").addEventListener("change", () => renderTemplateFields(true));

function setSize(w, h) {
  $("width").value = w;
  $("height").value = h;
  highlightSizePreset();
}
function readSize() {
  const c = (v) => Math.min(128, Math.max(4, Math.round(+v || 32)));
  return { width: c($("width").value), height: c($("height").value) };
}
function highlightSizePreset() {
  const { width, height } = readSize();
  document.querySelectorAll("#sizePresets button").forEach((b) => b.classList.toggle("active", width === height && +b.dataset.size === width));
}
$("sizePresets").append(
  ...SIZE_PRESETS.map((s) => {
    const b = el("button", { textContent: `${s}×${s}`, dataset: { size: s } });
    b.onclick = () => setSize(s, s);
    return b;
  }),
);
$("width").addEventListener("input", () => {
  if ($("square").checked) $("height").value = $("width").value;
  highlightSizePreset();
});
$("height").addEventListener("input", () => {
  if ($("square").checked) $("width").value = $("height").value;
  highlightSizePreset();
});

// パレット選択
let customPalette = storage.get("dotai.customPalette", PALETTES.custom.colors);
function selectedPaletteColors() {
  const key = $("palette").value;
  return key === "custom" ? customPalette : PALETTES[key].colors;
}
function renderPaletteSelect() {
  $("palette").replaceChildren(...Object.entries(PALETTES).map(([k, p]) => el("option", { value: k, textContent: p.label })));
}
function renderPaletteSwatches() {
  const key = $("palette").value;
  const colors = selectedPaletteColors();
  const box = $("paletteSwatches");
  box.replaceChildren();
  colors.forEach((c, i) => {
    const s = el("div", { className: "swatch", title: key === "custom" ? `${c}（クリックで変更・右クリックで削除）` : c });
    s.style.background = c;
    if (key === "custom") {
      s.onclick = () => pickColor(c, (v) => { customPalette[i] = v; saveCustom(); });
      s.oncontextmenu = (e) => { e.preventDefault(); customPalette.splice(i, 1); saveCustom(); };
    }
    box.append(s);
  });
  if (key === "custom") {
    const add = el("div", { className: "swatch", textContent: "+", title: "色を追加" });
    add.style.cssText = "display:grid;place-items:center;color:var(--muted)";
    add.onclick = () => pickColor("#888888", (v) => { customPalette.push(v); saveCustom(); });
    box.append(add);
  }
  if (colors.length) {
    $("maxColors").max = Math.min(32, colors.length);
    if (+$("maxColors").value > colors.length) $("maxColors").value = colors.length;
  } else {
    $("maxColors").max = 32;
  }
  $("maxColorsOut").textContent = $("maxColors").value;
}
function saveCustom() {
  storage.set("dotai.customPalette", customPalette);
  renderPaletteSwatches();
}
function pickColor(initial, cb) {
  const input = el("input", { type: "color", value: initial });
  input.addEventListener("change", () => cb(input.value));
  input.click();
}
$("palette").addEventListener("change", renderPaletteSwatches);
$("maxColors").addEventListener("input", () => ($("maxColorsOut").textContent = $("maxColors").value));

/* ---------- 静止画／アニメの切り替え ---------- */
// [ボタンの表示名, 入力欄に入る説明]
const MOTION_PRESETS = [
  ["待機", "待機（呼吸で体が少し上下する）"],
  ["歩く", "歩く（足を交互に出す）"],
  ["走る", "走る（腕を振り、足を大きく交互に出す）"],
  ["ジャンプ", "ジャンプ（しゃがむ→跳ぶ→着地）"],
  ["攻撃", "攻撃（武器を振る）"],
  ["ダメージ", "ダメージを受けてのけぞる"],
  ["揺れる", "ゆらゆら揺れる"],
  ["光る", "光る・きらめく"],
  ["回転", "回転する"],
  ["作業", "作業する（工場で部品を組み立てる）"],
  ["炎", "炎が揺らめく"],
  ["水面", "水面が波打つ"],
];
const FRAME_COUNTS = [2, 3, 4, 6, 8, 16];
const MODE_KEY = "dotai.mode";
let mode = "still";

function setMode(m) {
  mode = m === "anim" ? "anim" : "still";
  storage.set(MODE_KEY, mode);
  document.querySelectorAll(".mode-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
    b.setAttribute("aria-selected", b.dataset.mode === mode);
  });
  $("stillPane").hidden = mode !== "still";
  $("animPane").hidden = mode !== "anim";
  $("stillOptions").hidden = mode !== "still";
  $("generate").textContent = mode === "anim" ? "🎞 アニメを生成する" : "✨ 生成する";
}
document.querySelectorAll(".mode-tabs button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

// 入力欄の内容と一致する候補ボタンを強調する
function highlightMotion() {
  const v = $("motion").value.trim();
  document.querySelectorAll("#motionPresets button").forEach((b) => b.classList.toggle("active", b.dataset.value === v));
}
$("motionPresets").append(
  ...MOTION_PRESETS.map(([label, value]) => {
    const b = el("button", { type: "button", textContent: label, title: value, dataset: { value } });
    b.onclick = () => {
      $("motion").value = value;
      highlightMotion();
      saveForm();
    };
    return b;
  }),
);
$("motion").addEventListener("input", highlightMotion);

function setFrameCount(n) {
  $("frameCount").value = n;
  document.querySelectorAll("#frameCountChips button").forEach((b) => b.classList.toggle("active", +b.dataset.n === +n));
}
$("frameCountChips").append(
  ...FRAME_COUNTS.map((n) => {
    const b = el("button", { type: "button", textContent: `${n}コマ`, dataset: { n } });
    b.onclick = () => {
      setFrameCount(n);
      saveForm();
    };
    return b;
  }),
);

/* ---------- 入力内容の保存・復元（再起動してもプロンプト等が消えないように） ---------- */
const FORM_KEY = "dotai.form";
const FORM_IDS = [
  "prompt", "width", "height", "square", "maxColors",
  "stTransparent", "stSymmetry", "stOutline", "stTileable", "stDither",
  "variations", "motion", "frameCount",
];

function saveForm() {
  const data = { template: $("template").value, palette: $("palette").value, fields: {} };
  for (const id of FORM_IDS) data[id] = $(id).type === "checkbox" ? $(id).checked : $(id).value;
  document.querySelectorAll("#templateFields input").forEach((i) => (data.fields[i.dataset.key] = i.value));
  storage.set(FORM_KEY, data);
}

function restoreForm() {
  const data = storage.get(FORM_KEY, null);
  if (!data) return;
  const hasOption = (sel, v) => [...$(sel).options].some((o) => o.value === v);
  // テンプレ → 各項目 → パレット → その他（プロンプトは最後に戻して、自動作成で上書きされないようにする）
  if (hasOption("template", data.template)) {
    $("template").value = data.template;
    renderTemplateFields(false);
  }
  document.querySelectorAll("#templateFields input").forEach((i) => (i.value = data.fields?.[i.dataset.key] ?? ""));
  if (hasOption("palette", data.palette)) {
    $("palette").value = data.palette;
    renderPaletteSwatches();
  }
  for (const id of FORM_IDS) {
    if (data[id] === undefined) continue;
    if ($(id).type === "checkbox") $(id).checked = data[id];
    else if ($(id).tagName !== "SELECT" || hasOption(id, data[id])) $(id).value = data[id];
  }
  $("maxColorsOut").textContent = $("maxColors").value;
}

function readForm() {
  const { width, height } = readSize();
  return {
    prompt: $("prompt").value.trim(),
    width,
    height,
    maxColors: +$("maxColors").value,
    palette: selectedPaletteColors(),
    style: {
      transparent: $("stTransparent").checked,
      symmetry: $("stSymmetry").checked,
      outline: $("stOutline").checked,
      tileable: $("stTileable").checked,
      dither: $("stDither").checked,
    },
  };
}

// AIの出力を設定どおりに整える（パレット固定・色数・対称・背景透過）
function postProcess(g, form) {
  let out = g;
  if (form.palette.length) out = px.mapToPalette(out, form.palette);
  out = px.reduceColors(out, form.maxColors);
  if (form.style.symmetry) out = px.mirrorLeftToRight(out);
  if (form.style.transparent && !out.pixels.includes(-1)) out = px.removeBackground(out);
  return out;
}

const GEN_BUTTONS = ["generate", "refine"];
// 生成中はボタンを無効化し、経過時間を表示する
async function busy(label, task) {
  GEN_BUTTONS.forEach((id) => ($(id).disabled = true));
  const started = Date.now();
  const tick = () => setStatus(`${label()} ${Math.round((Date.now() - started) / 1000)}秒`, "busy");
  tick();
  const timer = setInterval(tick, 500);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    GEN_BUTTONS.forEach((id) => ($(id).disabled = false));
  }
}

const warnText = (w) => (w?.length ? `\n⚠ ${w.join(" / ")}（自動補正済み）` : "");

async function generate(refine) {
  const form = readForm();
  if (!form.prompt) return setStatus("プロンプトを入力してください", "error");
  const count = +$("variations").value;
  const base = refine ? editor.grid : null;
  const size = base ? { width: base.width, height: base.height } : { width: form.width, height: form.height };
  const body = { ...form, ...size };
  if (base) body.base = { width: base.width, height: base.height, palette: [...base.palette], pixels: [...base.pixels] };

  candidates = [];
  renderCandidates();
  let done = 0;
  let loaded = false;
  const errors = [];
  const warnings = [];
  let model = "";

  await busy(() => (count > 1 ? `生成中… ${done}/${count}案 完了` : "生成中…"), () => Promise.all(
    Array.from({ length: count }, (_, i) =>
      api("/api/generate", { method: "POST", body: { ...body, variation: { index: i + 1, total: count } } })
        .then(async (result) => {
          model = result.model;
          warnings.push(...result.warnings);
          const g = postProcess(result, { ...form, ...size });
          const doc = { width: g.width, height: g.height, palette: g.palette, frames: [g.pixels], fps: 8 };
          const meta = { title: result.title || form.prompt.slice(0, 20), prompt: form.prompt };
          const saved = await saveRecord(doc, meta);
          const cand = { doc, meta: { ...meta, id: saved.id } };
          candidates.push(cand);
          renderCandidates();
          // 最初に届いた案をすぐキャンバスに表示する
          if (!loaded) {
            loaded = true;
            loadCandidate(cand);
          }
        })
        .catch((err) => errors.push(err.message))
        .finally(() => done++),
    ),
  ));

  await loadHistory();
  const ok = count - errors.length;
  if (!ok) return setStatus(errors[0], "error");
  const errText = errors.length ? `\n✖ ${errors.length}案は失敗: ${errors[0]}` : "";
  setStatus(`完了: ${ok}案（${model}）${count > 1 ? "\n右の「候補」から選べます" : ""}${errText}${warnText([...new Set(warnings)])}`, errors.length ? "error" : "");
}
$("generate").onclick = () => (mode === "anim" ? animate() : generate(false));
$("refine").onclick = () => generate(true);

function loadCandidate(c) {
  editor.setDoc(c.doc, { meta: { ...c.meta } });
}

function renderCandidates() {
  $("candidatesSection").hidden = candidates.length < 2;
  const box = $("candidates");
  box.replaceChildren();
  candidates.forEach((c, i) => {
    const img = el("img", { src: px.renderToCanvas(px.frameGrid(c.doc, 0), 1).toDataURL(), alt: c.meta.title });
    const card = el("div", { className: "item" + (c.meta.id === current.id ? " current" : ""), title: c.meta.title }, [
      img, el("div", { className: "title", textContent: `案${i + 1}: ${c.meta.title}` }),
    ]);
    card.onclick = () => loadCandidate(c);
    box.append(card);
  });
}

async function animate() {
  const motion = $("motion").value.trim();
  if (!motion) return setStatus("動きを選ぶか入力してください（例: 歩く）", "error");
  const base = editor.grid;
  if (!base.pixels.some((v) => v >= 0)) return setStatus("先に絵を生成するか描いてから実行してください", "error");
  const form = readForm();
  const frameCount = +$("frameCount").value;
  try {
    const result = await busy(() => `${frameCount}コマのアニメを生成中…`, () => api("/api/generate", {
      method: "POST",
      body: {
        prompt: form.prompt || current.prompt || current.title,
        maxColors: form.maxColors,
        style: form.style,
        width: base.width,
        height: base.height,
        base: { width: base.width, height: base.height, palette: [...base.palette], pixels: [...base.pixels] },
        animation: { motion, frameCount },
      },
    }));
    const generated = result.frames.map((pixels) => ({ width: base.width, height: base.height, palette: result.palette, pixels }));
    let doc = px.gridsToDoc([{ ...base, pixels: [...base.pixels] }, ...generated], editor.doc.fps || 8);
    // 1コマ目の色は減らさないよう、上限は「1コマ目の色数」以上にする
    const baseColors = new Set(base.pixels.filter((v) => v >= 0)).size;
    doc = stacked((g) => {
      let out = form.palette.length ? px.mapToPalette(g, form.palette) : g;
      return px.reduceColors(out, Math.max(form.maxColors, baseColors));
    })(doc);
    editor.setDoc(doc, {
      meta: { id: null, title: `${current.title || result.title}（${motion.replace(/（.*$/, "")}）`, prompt: current.prompt || form.prompt },
    });
    await saveToHistory(false);
    // AIが決めた各コマのポーズも見せる（思った動きと違うときに、どこがずれたか分かるように）
    const posesText = (result.stillParts ? `\n動かさない部分: ${result.stillParts}` : "") +
      (result.poses?.length ? "\n" + result.poses.map((p, i) => `${i + 2}コマ目: ${p}`).join("\n") : "");
    setStatus(`完了: ${doc.frames.length}コマ（${result.model}・${(result.ms / 1000).toFixed(1)}秒）${posesText}${warnText(result.warnings)}`);
  } catch (err) {
    setStatus(err.message, "error");
  }
}

/* ---------- 書き出し・履歴 ---------- */
function download(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileBase = () => (current.title || "dotai").replace(/[\\/:*?"<>|\s]+/g, "_");
const exportScale = () => +$("exportScale").value;

$("downloadPng").onclick = () => {
  const s = exportScale();
  const suffix = editor.frameCount > 1 ? `_f${editor.frame + 1}` : "";
  px.renderToCanvas(editor.grid, s).toBlob((b) => download(b, `${fileBase()}${suffix}_x${s}.png`));
};
$("downloadSheet").onclick = () => {
  const s = exportScale();
  const d = editor.doc;
  px.renderSheet(d, +$("sheetCols").value, s).toBlob((b) => download(b, `${fileBase()}_sheet_${d.frames.length}f_${d.width * s}x${d.height * s}.png`));
};
$("downloadGif").onclick = () => {
  download(new Blob([encodeGif(editor.doc, exportScale())], { type: "image/gif" }), `${fileBase()}.gif`);
};
$("downloadJson").onclick = () => {
  const { width, height, palette, frames, fps } = editor.doc;
  const json = JSON.stringify({ title: current.title, prompt: current.prompt, width, height, palette, frames, fps });
  download(new Blob([json], { type: "application/json" }), `${fileBase()}.json`);
};

// doc を履歴に保存（サムネイルは1コマ目）
function saveRecord(doc, meta) {
  const { width, height, palette, frames, fps } = doc;
  return api("/api/history", {
    method: "POST",
    body: {
      ...meta,
      width, height, palette, frames, fps,
      pixels: frames[0],
      png: px.renderToCanvas(px.frameGrid(doc, 0), 1).toDataURL("image/png"),
    },
  });
}

async function saveToHistory(asNew) {
  const item = await saveRecord(editor.doc, {
    id: asNew ? null : current.id,
    title: current.title,
    prompt: current.prompt,
  });
  current.id = item.id;
  await loadHistory();
  return item;
}
$("saveHistory").onclick = async () => {
  try {
    await saveToHistory(false);
    setStatus("保存しました");
  } catch (err) {
    setStatus(err.message, "error");
  }
};
$("saveHistoryNew").onclick = async () => {
  const title = prompt("タイトル", current.title || "");
  if (title === null) return;
  current.title = title;
  try {
    await saveToHistory(true);
    setStatus("別名で保存しました");
    updateInfo();
  } catch (err) {
    setStatus(err.message, "error");
  }
};

async function loadHistory() {
  const items = await api("/api/history");
  const box = $("history");
  box.replaceChildren();
  if (!items.length) box.append(el("div", { className: "hint", textContent: "まだありません" }));
  for (const it of items) {
    const img = el("img", { src: `/api/history/${it.id}.png?v=${encodeURIComponent(it.updatedAt)}`, alt: it.title, loading: "lazy" });
    const del = el("button", { className: "del", textContent: "×", title: "削除" });
    const card = el("div", { className: "item", title: `${it.title}\n${it.prompt || ""}`, dataset: { id: it.id } }, [
      img, el("div", { className: "title", textContent: it.title || "(無題)" }), del,
    ]);
    if (it.frameCount > 1) card.append(el("span", { className: "frames-badge", textContent: `🎞${it.frameCount}` }));
    card.onclick = async () => {
      const full = await api(`/api/history/${it.id}`);
      if (full.prompt) $("prompt").value = full.prompt;
      editor.setDoc({ ...full, frames: full.frames || [full.pixels], fps: full.fps || 8 }, {
        meta: { id: full.id, title: full.title, prompt: full.prompt },
      });
    };
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`「${it.title || "無題"}」を削除しますか？`)) return;
      await api(`/api/history/${it.id}`, { method: "DELETE" });
      if (current.id === it.id) current.id = null;
      loadHistory();
    };
    box.append(card);
  }
  renderHistoryHighlight();
}
function renderHistoryHighlight() {
  document.querySelectorAll("#history .item").forEach((c) => c.classList.toggle("current", c.dataset.id === current.id));
  updateInfo();
}

/* ---------- 設定 ---------- */
function renderBadge() {
  const p = settings.providers[settings.provider];
  $("providerBadge").textContent = `${p.label} / ${p.model}`;
}

function renderSettingsForm() {
  $("providerSelect").replaceChildren(
    ...Object.entries(settings.providers).map(([k, p]) => el("option", { value: k, textContent: p.label, selected: k === settings.provider })),
  );
  const box = $("providerForms");
  box.replaceChildren();
  for (const [k, p] of Object.entries(settings.providers)) {
    const form = el("div", { className: "provider-form", dataset: { provider: k } });
    form.hidden = k !== settings.provider;
    form.append(el("h3", { textContent: p.label }));
    if (k === "claudecode") {
      form.append(el("div", { className: "hint", textContent:
        "このPCでログイン済みの Claude Code（claude コマンド）を使います。APIキーは不要で、Pro/Max の利用枠を使います。" +
        "1回ごとにコマンドを起動するため、APIより少し時間がかかります。" }));
    } else if (k !== "ollama") {
      const state = p.hasKey ? "設定済み（変更する場合のみ入力）" : p.hasEnvKey ? "環境変数のキーを使用中" : "未設定";
      const keyInput = el("input", { type: "password", name: "apiKey", placeholder: state, autocomplete: "off" });
      form.append(el("label", { textContent: "APIキー " }, [el("span", { className: "key-state", textContent: `（${state}）` }), keyInput]));
      if (p.hasKey) {
        const clear = el("button", { type: "button", textContent: "保存済みキーを削除" });
        clear.onclick = () => { keyInput.dataset.clear = "1"; keyInput.placeholder = "保存時に削除されます"; };
        form.append(clear);
      }
    } else {
      form.append(el("label", { textContent: "サーバーURL" }, [el("input", { type: "text", name: "baseUrl", value: p.baseUrl || "" })]));
    }
    // モデルは一覧から選ぶ。一覧にないものは「その他（手入力）」
    const modelSel = el("select", { name: "modelSelect" });
    const custom = el("input", { type: "text", name: "model", value: p.model, placeholder: "モデル名を入力" });
    // replaceUnknown: 保存中のモデルが一覧にない（提供終了など）場合、一覧の先頭に差し替える
    const fillModels = (models, replaceUnknown = false) => {
      if (replaceUnknown && models.length && !models.some((m) => m.id === custom.value)) {
        modelNote.textContent = custom.value ? `「${custom.value}」は使えないため「${models[0].id}」に変更しました（保存で反映）` : "";
        custom.value = models[0].id;
      }
      const known = models.some((m) => m.id === custom.value);
      modelSel.replaceChildren(
        ...models.map((m) => el("option", { value: m.id, textContent: m.label, selected: m.id === custom.value })),
        el("option", { value: "__custom", textContent: "その他（手入力）", selected: !known }),
      );
      custom.hidden = known;
    };
    modelSel.onchange = () => {
      custom.hidden = modelSel.value !== "__custom";
      if (modelSel.value === "__custom") custom.focus();
      else custom.value = modelSel.value;
    };
    const modelNote = el("div", { className: "hint" });
    fillModels(p.models);
    form.append(el("label", { textContent: "モデル" }, [modelSel, custom, modelNote]));
    // 各社から実際に使えるモデルを取得して選択肢を差し替える
    const loadModels = () => {
      const baseUrl = form.querySelector('[name="baseUrl"]')?.value;
      modelNote.textContent = "使えるモデルを取得中…";
      api(`/api/models?provider=${k}${baseUrl ? `&baseUrl=${encodeURIComponent(baseUrl)}` : ""}`)
        .then((models) => {
          const empty = k === "ollama" ? "インストール済みのモデルがありません（ollama pull で追加）" : "使えるモデルがありません";
          modelNote.textContent = models.length ? "" : empty;
          fillModels(models, true);
        })
        .catch((err) => (modelNote.textContent = k === "ollama" ? "Ollama に接続できません。起動しているか確認してください" : err.message));
    };
    form.querySelector('[name="baseUrl"]')?.addEventListener("change", loadModels);
    loadModels();
    if (k === "claude" || k === "claudecode") {
      const sel = el("select", { name: "effort" }, ["low", "medium", "high", "xhigh", "max"].map((v) =>
        el("option", { value: v, textContent: v, selected: v === (p.effort || "medium") })));
      form.append(el("label", { textContent: "思考の深さ (effort)：高いほど丁寧だが遅く高価" }, [sel]));
    }
    box.append(form);
  }
}
$("providerSelect").addEventListener("change", (e) => {
  document.querySelectorAll(".provider-form").forEach((f) => (f.hidden = f.dataset.provider !== e.target.value));
});
$("openSettings").onclick = () => {
  renderSettingsForm();
  const mode = importMode();
  $("importMode").replaceChildren(
    ...Object.entries(IMPORT_MODES).map(([k, label]) => el("option", { value: k, textContent: label, selected: k === mode })),
  );
  $("settingsDialog").showModal();
};
$("saveSettings").addEventListener("click", async (e) => {
  e.preventDefault();
  const update = { provider: $("providerSelect").value, providers: {} };
  document.querySelectorAll(".provider-form").forEach((f) => {
    const p = {};
    f.querySelectorAll("input, select").forEach((i) => {
      if (i.name === "modelSelect") return;
      if (i.name === "apiKey") p.apiKey = i.dataset.clear ? null : i.value;
      else p[i.name] = i.value;
    });
    update.providers[f.dataset.provider] = p;
  });
  storage.set("dotai.importMode", $("importMode").value);
  try {
    settings = await api("/api/settings", { method: "POST", body: update });
    renderBadge();
    $("settingsDialog").close();
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- 起動 ---------- */
renderTemplateSelect();
renderPaletteSelect();
renderPaletteSwatches();
renderTemplateFields(false);
restoreForm();
highlightSizePreset();
setFrameCount(FRAME_COUNTS.includes(+$("frameCount").value) ? +$("frameCount").value : 4);
highlightMotion();
setMode(storage.get(MODE_KEY, "still"));
// 左パネルの入力が変わるたびに保存（サイズのプリセットボタン等はクリックで値が変わるので click も見る）
for (const type of ["input", "change", "click"]) $("leftPanel").addEventListener(type, saveForm);
editor.setGrid(px.emptyGrid(32, 32), { keepHistory: false });
setTool("pen");
requestAnimationFrame(previewLoop);
try {
  settings = await api("/api/settings");
  renderBadge();
  const p = settings.providers[settings.provider];
  if (!["ollama", "claudecode"].includes(settings.provider) && !p.hasKey && !p.hasEnvKey) setStatus("右上の「⚙ 設定」からAPIキーを登録してください");
} catch (err) {
  setStatus("サーバーに接続できません: " + err.message, "error");
}
loadHistory().catch(() => {});
window.addEventListener("resize", () => {
  editor.fitZoom();
  editor.render();
  updateInfo();
});
