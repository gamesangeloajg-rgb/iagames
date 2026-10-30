import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 64 * 1024;

// Load local settings without adding a runtime dependency. Existing process env wins.
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function bodyJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY) throw Object.assign(new Error("Corpo da requisição excede 64 KB."), { status: 413 });
  }
  try { return JSON.parse(raw || "{}"); }
  catch { throw Object.assign(new Error("JSON inválido."), { status: 400 }); }
}
function guessType(prompt) {
  return /\b(jogo|game|fase|personagem|plataforma|rpg|corrida|puzzle)\b/i.test(prompt) ? "game" : "app";
}
function parseModelJson(content) {
  const cleaned = content.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
  const first = cleaned.indexOf("{"), last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("O modelo não retornou JSON.");
  return JSON.parse(cleaned.slice(first, last + 1));
}
function validatePlan(input, fallbackType) {
  const str = (v, max = 500) => typeof v === "string" ? v.trim().slice(0, max) : "";
  const arr = (v, count) => Array.isArray(v) ? v.slice(0, count).map(x => str(x, 180)).filter(Boolean) : [];
  const plan = {
    title: str(input.title, 90) || "Novo projeto",
    type: input.type === "game" || input.type === "app" ? input.type : fallbackType,
    summary: str(input.summary, 900),
    features: arr(input.features, 8),
    techStack: arr(input.techStack, 6),
    milestones: arr(input.milestones, 8)
  };
  if (!plan.summary || !plan.features.length || !plan.milestones.length) throw new Error("O plano retornado está incompleto.");
  return plan;
}
async function planProject(prompt) {
  const key = process.env.AI_API_KEY;
  if (!key) return { status: 503, body: { error: "AI_NOT_CONFIGURED", message: "Servidor ativo, mas AI_API_KEY não está configurada no .env." } };
  if (!process.env.AI_MODEL) return { status: 503, body: { error: "AI_MODEL_MISSING", message: "Configure AI_MODEL no .env para selecionar o modelo." } };
  const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const type = guessType(prompt);
  const system = "Você é o agente de planejamento do IA Games. Analise o briefing e retorne SOMENTE JSON válido, sem markdown, com title (string), type (game ou app), summary (string em português), features (array de strings), techStack (array de strings), milestones (array de strings). Identifique automaticamente jogo ou aplicativo. Sugira no máximo 8 funcionalidades, 6 tecnologias e 8 etapas. Não diga que código foi gerado ou executado. Nunca solicite nem revele segredos.";
  const response = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.AI_MODEL, temperature: 0.3, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: "Briefing do usuário:\n" + prompt }] }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) return { status: 502, body: { error: "AI_AUTH_FAILED", message: "O provedor recusou a autenticação. Confira a chave e as permissões." } };
    if (status === 429) return { status: 502, body: { error: "AI_RATE_LIMIT", message: "O provedor limitou temporariamente as solicitações. Tente novamente mais tarde." } };
    return { status: 502, body: { error: "AI_PROVIDER_ERROR", message: "O provedor de IA retornou HTTP " + status + "." } };
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Resposta vazia do provedor.");
  return { status: 200, body: { plan: validatePlan(parseModelJson(content), type) } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL) });
  }
  if (req.method === "POST" && url.pathname === "/api/projects/plan") {
    try {
      const body = await bodyJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (prompt.length < 8 || prompt.length > 5000) return json(res, 400, { error: "INVALID_PROMPT", message: "O briefing deve ter entre 8 e 5.000 caracteres." });
      const result = await planProject(prompt);
      return json(res, result.status, result.body);
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") return json(res, 504, { error: "AI_TIMEOUT", message: "O modelo demorou demais para responder. Tente novamente." });
      return json(res, error.status || 502, { error: "PLAN_FAILED", message: error.status ? error.message : "Falha ao gerar o plano. Confira o provedor e tente novamente." });
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "METHOD_NOT_ALLOWED", message: "Método não permitido." });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: "BAD_PATH", message: "Caminho inválido." }); }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(ROOT, relative);
  if (!target.startsWith(ROOT + sep)) return json(res, 403, { error: "FORBIDDEN", message: "Caminho não permitido." });
  try {
    const data = await readFile(target);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
    res.writeHead(200, { "content-type": types[extname(target)] || "application/octet-stream", "x-content-type-options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch { json(res, 404, { error: "NOT_FOUND", message: "Arquivo não encontrado." }); }
});
server.listen(PORT, HOST, () => console.log("IA Games disponível em http://" + HOST + ":" + PORT));
