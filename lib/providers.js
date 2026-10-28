// LLMプロバイダーごとの呼び出し。どれも (設定, system, user, 出力JSONスキーマ) を受け取り、JSON文字列を返す。
import Anthropic from "@anthropic-ai/sdk";

export const PROVIDERS = {
  claude: { label: "Claude (Anthropic)", defaultModel: "claude-opus-5-5", envKey: "ANTHROPIC_API_KEY" },
  gemini: { label: "Gemini (Google)", defaultModel: "gemini-2.5-flash", envKey: "GEMINI_API_KEY" },
  openai: { label: "OpenAI", defaultModel: "gpt-4.1", envKey: "OPENAI_API_KEY" },
  ollama: { label: "Ollama (ローカル)", defaultModel: "llama3.1", envKey: null },
};

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
  if (!res.ok) throw new Error(`API エラー (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
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
  return fn(cfg, system, user, schema);
}
