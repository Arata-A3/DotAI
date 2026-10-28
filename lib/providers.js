// LLMプロバイダーごとの呼び出し。どれも (設定, system, user, 出力JSONスキーマ) を受け取り、JSON文字列を返す。
import Anthropic from "@anthropic-ai/sdk";

// models はおすすめの選択肢（一覧の先頭に並べる）。実際の選択肢は /api/models で各社から取得し、
// 取得できないときだけこの一覧を使う。一覧にないモデルは「その他（手入力）」で指定できる
export const PROVIDERS = {
  claude: {
    label: "Claude (Anthropic)", defaultModel: "claude-opus-5-5", envKey: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5（高品質・おすすめ）" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5（速さと品質のバランス）" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5（高速・低価格）" },
      { id: "claude-fable-5-1", label: "Fable 5.1（最高性能・高価）" },
    ],
  },
  gemini: {
    label: "Gemini (Google)", defaultModel: "gemini-flash-latest", envKey: "GEMINI_API_KEY",
    // *-latest は常に最新版を指す別名なので、提供終了の影響を受けにくい。
    // 無料枠では Pro の上限がとても小さいため Flash をおすすめにする
    models: [
      { id: "gemini-flash-latest", label: "Flash 最新版（おすすめ・無料枠でも使いやすい）" },
      { id: "gemini-pro-latest", label: "Pro 最新版（高品質・無料枠では上限が小さい）" },
    ],
  },
  openai: {
    // おすすめは固定せず、取得した一覧を新しい順に並べる（固定するとすぐ古くなるため）
    label: "OpenAI", defaultModel: "gpt-4.1", envKey: "OPENAI_API_KEY", models: [],
  },
  // Ollama はPCに入っているモデルが選択肢になる
  ollama: { label: "Ollama (ローカル)", defaultModel: "llama3.1", envKey: null, models: [] },
};

// おすすめを先頭（定義順）に、残りは newer(a, b) の順に並べ、おすすめのラベルを付ける
function orderModels(provider, models, newer) {
  const recommended = PROVIDERS[provider].models;
  const rank = (m) => {
    const i = recommended.findIndex((r) => r.id === m.id);
    return i < 0 ? Infinity : i;
  };
  return models
    .sort((a, b) => rank(a) - rank(b) || newer(a, b))
    .map((m) => ({ id: m.id, label: recommended.find((r) => r.id === m.id)?.label ?? m.label }));
}

export async function listClaudeModels(apiKey) {
  const NO_KEY = "Claude のAPIキーを保存すると、使えるモデルが表示されます";
  let client;
  try {
    client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  } catch {
    throw new Error(NO_KEY);
  }
  const models = [];
  try {
    for await (const m of client.models.list()) {
      models.push({ id: m.id, label: m.display_name === m.id ? m.id : `${m.display_name}（${m.id}）`, created: m.created_at });
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Claude のAPIキーが無効です");
    if (err instanceof Anthropic.APIError) throw new Error(`Claude のモデル一覧を取得できません (${err.status})`);
    if (/authentication method/i.test(err.message)) throw new Error(NO_KEY);
    throw err;
  }
  return orderModels("claude", models, (a, b) => b.created.localeCompare(a.created));
}

// チャット用のモデルだけ残す。日付付きの固定版、音声・画像・埋め込み用、構造化出力に非対応の古い世代は除く
export async function listOpenAIModels(apiKey) {
  if (!apiKey) throw new Error("OpenAI のAPIキーを保存すると、使えるモデルが表示されます");
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 401) throw new Error("OpenAI のAPIキーが無効です");
  if (!res.ok) throw new Error(`OpenAI のモデル一覧を取得できません (${res.status})`);
  const data = await res.json();
  const models = (data.data ?? [])
    .filter((m) => /^(gpt-|o\d)/.test(m.id))
    .filter((m) => !/(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|whisper|dall-e|codex)/.test(m.id))
    .filter((m) => !/-\d{4}-\d{2}-\d{2}$|-\d{4}$/.test(m.id))
    .filter((m) => !/^gpt-3|^gpt-4(-|$)/.test(m.id))
    .map((m) => ({ id: m.id, label: m.id, created: m.created }));
  return orderModels("openai", models, (a, b) => b.created - a.created);
}

// APIキーで使えるテキスト生成モデル（埋め込み・音声・画像専用などは除く）。
// 最新版の別名を先頭に、その後は新しいバージョン順。※一覧にあっても新規ユーザーには提供終了のモデルもある
export async function listGeminiModels(apiKey) {
  if (!apiKey) throw new Error("Gemini のAPIキーを保存すると、使えるモデルが表示されます");
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Gemini のモデル一覧を取得できません (${res.status})`);
  const data = await res.json();
  const models = (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }))
    .filter((m) => /^gemini-/.test(m.id) && !/(embedding|tts|image|live|audio|robotics|computer-use|transcribe|banana|customtools)/.test(m.id))
    .map((m) => ({ id: m.id, label: m.label === m.id ? m.id : `${m.label}（${m.id}）` }));
  return orderModels("gemini", models, (a, b) => {
    const latest = (m) => (m.id.endsWith("-latest") ? 0 : 1);
    return latest(a) - latest(b) || b.id.localeCompare(a.id, "en", { numeric: true });
  });
}

export function listModels(provider, cfg) {
  if (provider === "claude") return listClaudeModels(cfg.apiKey);
  if (provider === "gemini") return listGeminiModels(cfg.apiKey);
  if (provider === "openai") return listOpenAIModels(cfg.apiKey);
  if (provider === "ollama") return listOllamaModels(cfg.baseUrl);
  throw new Error(`不明なプロバイダー: ${provider}`);
}

export async function listOllamaModels(baseUrl) {
  const base = (baseUrl || "http://localhost:11434").replace(/\/$/, "");
  const res = await fetch(`${base}/api/tags`).catch(() => {
    throw new Error("Ollama に接続できません。起動しているか確認してください");
  });
  if (!res.ok) throw new Error(`Ollama に接続できません (${res.status})`);
  const data = await res.json();
  return (data.models ?? []).map((m) => ({ id: m.name, label: m.name }));
}

// サーバー側フォールバック（拒否時に別モデルで再試行）に対応したモデル
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

async function callClaude(cfg, system, user, schema) {
  const NO_KEY = "Claude のAPIキーが未設定です（設定画面か環境変数 ANTHROPIC_API_KEY で指定）";
  let client;
  try {
    client = cfg.apiKey ? new Anthropic({ apiKey: cfg.apiKey }) : new Anthropic();
  } catch {
    throw new Error(NO_KEY);
  }
  const params = {
    model: cfg.model,
    max_tokens: 64000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: {
      format: { type: "json_schema", schema },
      ...(cfg.effort ? { effort: cfg.effort } : {}),
    },
  };
  const stream = FALLBACK_MODELS.has(cfg.model)
    ? client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : client.messages.stream(params);

  let msg;
  try {
    msg = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Claude のAPIキーが無効です");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Claude のレート制限に達しました。少し待って再試行してください");
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API エラー (${err.status}): ${err.message}`);
    if (/authentication method/i.test(err.message)) throw new Error(NO_KEY);
    throw err;
  }
  if (msg.stop_reason === "refusal") throw new Error("Claude がこのリクエストを辞退しました。プロンプトを変えてください");
  if (msg.stop_reason === "max_tokens") throw new Error("出力が長すぎて途中で切れました。サイズを小さくしてください");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = null;
    try {
      detail = JSON.parse(text);
    } catch {}
    const err = new Error(`API エラー (${res.status}): ${detail?.error?.message ?? text.slice(0, 300)}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return JSON.parse(text);
}

// 利用上限（429）のときの案内文。Gemini はどの上限か・何秒後に回復するかを返すので、それも伝える
function quotaMessage(name, cfg, err) {
  const details = err.detail?.error?.details ?? [];
  const retry = details.find((d) => d.retryDelay)?.retryDelay;
  const quotaIds = [...new Set(details.flatMap((d) => d.violations ?? []).map((v) => v.quotaId).filter(Boolean))];
  const lines = [`${PROVIDERS[name].label} の利用上限に達しました（モデル: ${cfg.model}）。`];
  if (quotaIds.some((q) => /PerDay/i.test(q))) lines.push("1日あたりの上限です。翌日（米国太平洋時間の0時）にリセットされます。");
  else if (retry) lines.push(`約${parseInt(retry, 10)}秒後にもう一度試せます。`);
  if (name === "gemini" && /pro/.test(cfg.model)) {
    lines.push("無料枠では Pro モデルの上限がとても小さい（または0）ため、「⚙ 設定」で「Flash 最新版」に切り替えるのがおすすめです。");
  }
  lines.push("案の数を減らすと、1回の生成で使う回数も減ります。上限を増やすには各社の管理画面で課金を設定してください。");
  if (quotaIds.length) lines.push(`（上限の種類: ${quotaIds.join(", ")}）`);
  return lines.join("\n");
}

async function callGemini(cfg, system, user, schema) {
  if (!cfg.apiKey) throw new Error("Gemini のAPIキーが未設定です");
  const toGemini = (s) => {
    if (s.type === "object") {
      return {
        type: "OBJECT",
        properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGemini(v)])),
        required: s.required,
      };
    }
    if (s.type === "array") return { type: "ARRAY", items: toGemini(s.items) };
    return { type: "STRING" };
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const data = await postJson(
    url,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: toGemini(schema) },
    },
    { "x-goog-api-key": cfg.apiKey },
  );
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

async function callOpenAI(cfg, system, user, schema) {
  if (!cfg.apiKey) throw new Error("OpenAI のAPIキーが未設定です");
  const data = await postJson(
    "https://api.openai.com/v1/chat/completions",
    {
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name: "pixel_art", strict: true, schema } },
    },
    { Authorization: `Bearer ${cfg.apiKey}` },
  );
  return data.choices?.[0]?.message?.content ?? "";
}

async function callOllama(cfg, system, user, schema) {
  const base = (cfg.baseUrl || "http://localhost:11434").replace(/\/$/, "");
  const data = await postJson(`${base}/api/chat`, {
    model: cfg.model,
    stream: false,
    format: schema,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return data.message?.content ?? "";
}

const CALLERS = { claude: callClaude, gemini: callGemini, openai: callOpenAI, ollama: callOllama };

export async function callProvider(name, cfg, system, user, schema) {
  const fn = CALLERS[name];
  if (!fn) throw new Error(`不明なプロバイダー: ${name}`);
  try {
    return await fn(cfg, system, user, schema);
  } catch (err) {
    // モデルの提供終了・名前違いは、設定でのモデル選び直しを案内する
    if (err.status === 429) throw new Error(quotaMessage(name, cfg, err));
    if (err.status === 404) {
      throw new Error(`モデル「${cfg.model}」は使えないか、名前が違います。右上の「⚙ 設定」でモデルを選び直してください`);
    }
    throw err;
  }
}
