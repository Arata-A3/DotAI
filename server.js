// DotAI: 画面の配信・LLM呼び出し・保存をこの1つのサーバーで行う
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import {
  buildPrompt, buildAnimationPrompt, parseOutput, parseAnimationOutput, gridToRows, MAX_SIZE, MAX_COLORS, MAX_FRAMES,
} from "./lib/prompt.js";
import { callProvider, PROVIDERS } from "./lib/providers.js";
import * as store from "./lib/storage.js";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve("public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw new Error("リクエストが大きすぎます");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const clamp = (v, lo, hi, def) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : def);

async function handleGenerate(req, res) {
  const body = await readBody(req);
  if (!body.prompt?.trim() && !body.animation) return send(res, 400, { error: "プロンプトを入力してください" });
  const width = clamp(body.width, 4, MAX_SIZE, 32);
  const height = clamp(body.height, 4, MAX_SIZE, 32);
  const maxColors = clamp(body.maxColors, 2, MAX_COLORS, 16);

  const settings = await store.loadSettings();
  const providerName = PROVIDERS[body.provider] ? body.provider : settings.provider;
  const cfg = store.providerConfig(settings, providerName);

  const base = body.base ? { palette: body.base.palette, rows: gridToRows(body.base) } : null;
  const anim = body.animation;
  if (anim && !base) return send(res, 400, { error: "アニメーションには元になる絵が必要です" });
  if (anim && !anim.motion?.trim()) return send(res, 400, { error: "動きを入力してください" });
  const frameCount = anim ? clamp(anim.frameCount, 2, MAX_FRAMES, 4) : 1;

  const params = { ...body, width, height, maxColors, base };
  const { system, user, schema } = anim
    ? buildAnimationPrompt({ ...params, motion: anim.motion.trim(), frameCount })
    : buildPrompt(params);

  const started = Date.now();
  const text = await callProvider(providerName, cfg, system, user, schema);
  const result = anim ? parseAnimationOutput(text, width, height, frameCount - 1) : parseOutput(text, width, height);
  send(res, 200, { ...result, provider: providerName, model: cfg.model, ms: Date.now() - started });
}

async function serveStatic(res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/api/generate" && req.method === "POST") return await handleGenerate(req, res);

    if (p === "/api/settings") {
      if (req.method === "GET") return send(res, 200, store.publicSettings(await store.loadSettings()));
      if (req.method === "POST") return send(res, 200, store.publicSettings(await store.saveSettings(await readBody(req))));
    }

    if (p === "/api/history") {
      if (req.method === "GET") return send(res, 200, await store.listHistory());
      if (req.method === "POST") {
        const { png, ...item } = await readBody(req);
        const { pixels, frames, ...meta } = await store.saveHistory(item, png);
        return send(res, 200, { ...meta, frameCount: frames?.length || 1 });
      }
    }

    const m = p.match(/^\/api\/history\/([\w-]+)(\.png)?$/);
    if (m) {
      if (m[2]) return await serveStatic(res, path.join(store.HISTORY_DIR, `${m[1]}.png`));
      if (req.method === "GET") return send(res, 200, await store.getHistory(m[1]));
      if (req.method === "DELETE") {
        await store.deleteHistory(m[1]);
        return send(res, 200, { ok: true });
      }
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "not found" });

    const filePath = path.join(PUBLIC_DIR, p === "/" ? "index.html" : decodeURIComponent(p));
    if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "forbidden" });
    return await serveStatic(res, filePath);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || String(err) });
  }
});

await store.ensureDirs();
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`DotAI 起動: ${url}  (終了は Ctrl+C)`);
  if (process.argv.includes("--open")) {
    const cmd = process.platform === "win32" ? `start "" ${url}` : process.platform === "darwin" ? `open ${url}` : `xdg-open ${url}`;
    exec(cmd);
  }
});
