// 設定と生成履歴をローカルの data/ フォルダに保存する
import fs from "node:fs/promises";
import path from "node:path";
import { PROVIDERS } from "./providers.js";

export const DATA_DIR = path.resolve("data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const HISTORY_DIR = path.join(DATA_DIR, "history");

const DEFAULT_SETTINGS = {
  provider: "claude",
  providers: Object.fromEntries(
    Object.entries(PROVIDERS).map(([k, p]) => [k, { apiKey: "", model: p.defaultModel }]),
  ),
};
DEFAULT_SETTINGS.providers.claude.effort = "medium";
DEFAULT_SETTINGS.providers.ollama.baseUrl = "http://localhost:11434";

export async function ensureDirs() {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

export async function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"));
  } catch {}
  const merged = { provider: saved.provider || DEFAULT_SETTINGS.provider, providers: {} };
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS.providers)) {
    merged.providers[k] = { ...def, ...(saved.providers?.[k] ?? {}) };
  }
  return merged;
}

// 画面へ返す用：APIキー本体は返さず、設定済みかどうかだけ伝える
export function publicSettings(s) {
  const providers = {};
  for (const [k, p] of Object.entries(s.providers)) {
    const envKey = PROVIDERS[k].envKey;
    const { apiKey, ...rest } = p;
    providers[k] = {
      ...rest,
      label: PROVIDERS[k].label,
      models: PROVIDERS[k].models,
      hasKey: !!apiKey,
      hasEnvKey: !!(envKey && process.env[envKey]),
    };
  }
  return { provider: s.provider, providers };
}

export async function saveSettings(update) {
  const s = await loadSettings();
  if (update.provider && PROVIDERS[update.provider]) s.provider = update.provider;
  for (const [k, p] of Object.entries(update.providers ?? {})) {
    if (!s.providers[k]) continue;
    for (const field of ["model", "effort", "baseUrl"]) {
      if (typeof p[field] === "string") s.providers[k][field] = p[field].trim();
    }
    // 空文字は「変更しない」、null は「削除」
    if (typeof p.apiKey === "string" && p.apiKey.trim()) s.providers[k].apiKey = p.apiKey.trim();
    if (p.apiKey === null) s.providers[k].apiKey = "";
  }
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return s;
}

export function providerConfig(s, name) {
  const p = { ...s.providers[name] };
  const envKey = PROVIDERS[name].envKey;
  if (!p.apiKey && envKey) p.apiKey = process.env[envKey] || "";
  if (!p.model) p.model = PROVIDERS[name].defaultModel;
  return p;
}

const safeId = (id) => /^[\w-]+$/.test(id);

export async function listHistory() {
  const files = (await fs.readdir(HISTORY_DIR)).filter((f) => f.endsWith(".json"));
  const items = [];
  for (const f of files) {
    try {
      const { pixels, frames, ...meta } = JSON.parse(await fs.readFile(path.join(HISTORY_DIR, f), "utf8"));
      items.push({ ...meta, frameCount: frames?.length || 1 });
    } catch {}
  }
  return items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export async function getHistory(id) {
  if (!safeId(id)) throw new Error("bad id");
  return JSON.parse(await fs.readFile(path.join(HISTORY_DIR, `${id}.json`), "utf8"));
}

export async function saveHistory(item, pngDataUrl) {
  const id = item.id && safeId(item.id) ? item.id : `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const record = { ...item, id, createdAt: item.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(HISTORY_DIR, `${id}.json`), JSON.stringify(record));
  if (pngDataUrl?.startsWith("data:image/png;base64,")) {
    await fs.writeFile(path.join(HISTORY_DIR, `${id}.png`), Buffer.from(pngDataUrl.split(",")[1], "base64"));
  }
  return record;
}

export async function deleteHistory(id) {
  if (!safeId(id)) throw new Error("bad id");
  await fs.rm(path.join(HISTORY_DIR, `${id}.json`), { force: true });
  await fs.rm(path.join(HISTORY_DIR, `${id}.png`), { force: true });
}
