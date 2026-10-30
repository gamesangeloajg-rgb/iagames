import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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


const DATA_DIR = join(ROOT, ".iagames-data", "projects");
const ALLOWED_FILES = new Set(["index.html", "style.css", "script.js"]);
async function generateProject(prompt) {
  const key = process.env.AI_API_KEY;
  if (!key || !process.env.AI_MODEL) return { status: 503, body: { error: "AI_NOT_CONFIGURED", message: "Configure AI_API_KEY e AI_MODEL no servidor antes de gerar projetos." } };
  const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const system = [
    "Você é o agente construtor do IA Games. Gere um pequeno projeto web funcional com HTML, CSS e JavaScript puro.",
    "Retorne SOMENTE JSON válido com title, type (game ou app) e files (array de objetos path/content).",
    "Os únicos caminhos permitidos são index.html, style.css e script.js. Sempre inclua index.html e referencie os outros arquivos nele com caminhos relativos.",
    "Não use bibliotecas externas, CDNs, fontes remotas, chamadas de rede, armazenamento de credenciais ou APIs externas. Não inclua iframes, formulários que enviem dados, downloads automáticos ou acesso ao sistema de arquivos.",
    "O resultado deve ser uma demonstração frontend autossuficiente, responsiva e interativa, em português. Não inclua instruções para contornar sandbox.",
    "Limite a 3 arquivos e 60 KB de conteúdo total. Não inclua markdown."
  ].join(" ");
  const response = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.AI_MODEL, temperature: 0.4, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: "Crie o projeto a partir deste briefing:\\n" + prompt }] }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) return { status: 502, body: { error: "AI_GENERATION_FAILED", message: "O provedor não conseguiu gerar os arquivos (HTTP " + response.status + ")." } };
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Resposta vazia do provedor.");
  const generated = parseModelJson(content);
  const title = typeof generated.title === "string" ? generated.title.trim().slice(0, 90) : "Projeto IA Games";
  const type = generated.type === "game" ? "game" : "app";
  if (!Array.isArray(generated.files)) throw new Error("O modelo não retornou a lista de arquivos.");
  const seen = new Set();
  const files = [];
  let total = 0;
  for (const item of generated.files) {
    if (!item || !ALLOWED_FILES.has(item.path) || seen.has(item.path) || typeof item.content !== "string") continue;
    const size = Buffer.byteLength(item.content, "utf8");
    total += size;
    if (size > 40000 || total > 60000) throw new Error("Os arquivos gerados excederam o limite permitido.");
    seen.add(item.path);
    files.push({ path: item.path, content: item.content });
  }
  if (!seen.has("index.html") || !files.length) throw new Error("O projeto precisa conter um index.html válido.");
  return { status: 200, body: { title, type, files } };
}
async function saveProject(project) {
  const id = randomUUID();
  const directory = join(DATA_DIR, id);
  await mkdir(directory, { recursive: true });
  for (const file of project.files) await writeFile(join(directory, file.path), file.content, { encoding: "utf8", flag: "wx" });
  const metadata = { id, title: project.title, type: project.type, createdAt: new Date().toISOString(), files: project.files.map(file => file.path) };
  await writeFile(join(directory, "project.json"), JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" });
  return { ...metadata, content: project.files };
}
async function getProject(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const directory = join(DATA_DIR, id);
  try {
    const metadata = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
    const content = [];
    for (const path of metadata.files) {
      if (!ALLOWED_FILES.has(path)) continue;
      content.push({ path, content: await readFile(join(directory, path), "utf8") });
    }
    return { ...metadata, content };
  } catch { return null; }
}
async function listProjects() {
  await mkdir(DATA_DIR, { recursive: true });
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    try {
      const metadata = JSON.parse(await readFile(join(DATA_DIR, entry.name, "project.json"), "utf8"));
      projects.push({ id: metadata.id, title: metadata.title, type: metadata.type, createdAt: metadata.createdAt, files: metadata.files });
    } catch { /* Ignore incomplete/corrupt project folders. */ }
  }
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}


async function generateModification(project, prompt) {
  if (!process.env.AI_API_KEY || !process.env.AI_MODEL) return { status: 503, body: { error: "AI_NOT_CONFIGURED", message: "Configure AI_API_KEY e AI_MODEL no servidor." } };
  const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const system = [
    "Você é o agente de manutenção do IA Games. Modifique o projeto web existente conforme o pedido.",
    "Retorne SOMENTE JSON válido com title, type (game ou app) e files (array de objetos path/content).",
    "Retorne o conjunto COMPLETO de arquivos finais. Os únicos caminhos permitidos são index.html, style.css e script.js. Preserve funcionalidades não mencionadas.",
    "Não use bibliotecas externas, CDNs, rede, iframes, formulários que enviem dados ou acesso ao sistema de arquivos.",
    "Mantenha o projeto autossuficiente, responsivo e em português. Limite total 60 KB. Não inclua markdown."
  ].join(" ");
  const response = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.AI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.AI_MODEL, temperature: 0.25, response_format: { type: "json_object" }, messages: [
      { role: "system", content: system },
      { role: "user", content: "Pedido de alteração:\\n" + prompt + "\\n\\nProjeto atual:\\n" + JSON.stringify({ title: project.title, type: project.type, files: project.content }) }
    ] }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) return { status: 502, body: { error: "AI_MODIFICATION_FAILED", message: "O provedor não conseguiu modificar o projeto (HTTP " + response.status + ")." } };
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Resposta vazia do provedor.");
  const generated = parseModelJson(content);
  if (!Array.isArray(generated.files)) throw new Error("O modelo não retornou os arquivos finais.");
  const seen = new Set(), files = [];
  let total = 0;
  for (const item of generated.files) {
    if (!item || !ALLOWED_FILES.has(item.path) || seen.has(item.path) || typeof item.content !== "string") continue;
    const size = Buffer.byteLength(item.content, "utf8");
    total += size;
    if (size > 40000 || total > 60000) throw new Error("Os arquivos modificados excederam o limite permitido.");
    seen.add(item.path); files.push({ path: item.path, content: item.content });
  }
  if (!seen.has("index.html") || !files.length) throw new Error("A alteração precisa retornar um index.html válido.");
  return { status: 200, body: { title: typeof generated.title === "string" ? generated.title.trim().slice(0,90) : project.title, type: generated.type === "game" ? "game" : "app", files } };
}
async function readVersion(projectId, versionId) {
  if (!/^[0-9a-f-]{36}$/i.test(projectId) || !/^v[0-9]+-[0-9a-f]{8}$/i.test(versionId)) return null;
  try { return JSON.parse(await readFile(join(DATA_DIR, projectId, "versions", versionId + ".json"), "utf8")); }
  catch { return null; }
}
async function createSnapshot(project) {
  const directory = join(DATA_DIR, project.id, "versions");
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const path of project.files) if (ALLOWED_FILES.has(path)) files.push({ path, content: await readFile(join(DATA_DIR, project.id, path), "utf8") });
  const versionId = "v" + Date.now() + "-" + randomUUID().slice(0,8);
  const snapshot = { versionId, title: project.title, type: project.type, createdAt: new Date().toISOString(), files };
  await writeFile(join(directory, versionId + ".json"), JSON.stringify(snapshot), { flag: "wx" });
  return { versionId, createdAt: snapshot.createdAt };
}
async function applyProjectFiles(projectId, files) {
  const directory = join(DATA_DIR, projectId);
  for (const file of files) {
    const temporary = join(directory, "." + file.path + "." + randomUUID() + ".tmp");
    await writeFile(temporary, file.content, { encoding: "utf8", flag: "wx" });
    await (await import("node:fs/promises")).rename(temporary, join(directory, file.path));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL) });
  }


  const projectAction = url.pathname.match(/^\/api\/projects\/([0-9a-f-]{36})\/(modify|versions|rollback)$/i);
  if (projectAction && req.method === "GET" && projectAction[2] === "versions") {
    const project = await getProject(projectAction[1]);
    if (!project) return json(res, 404, { error: "PROJECT_NOT_FOUND", message: "Projeto não encontrado." });
    const versions = Array.isArray(project.versions) ? project.versions : [];
    return json(res, 200, { versions });
  }
  if (projectAction && req.method === "POST" && projectAction[2] === "modify") {
    try {
      const project = await getProject(projectAction[1]);
      if (!project) return json(res, 404, { error: "PROJECT_NOT_FOUND", message: "Projeto não encontrado." });
      const body = await bodyJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (prompt.length < 8 || prompt.length > 5000) return json(res, 400, { error: "INVALID_PROMPT", message: "A alteração deve ter entre 8 e 5.000 caracteres." });
      const changed = await generateModification(project, prompt);
      if (changed.status !== 200) return json(res, changed.status, changed.body);
      const directory = join(DATA_DIR, project.id);
      const metadata = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
      const snapshot = await createSnapshot(metadata);
      await applyProjectFiles(project.id, changed.body.files);
      const nextFiles = changed.body.files.map(file => file.path);
      const updated = { ...metadata, title: changed.body.title, type: changed.body.type, files: nextFiles, updatedAt: new Date().toISOString(), versions: [...(metadata.versions || []), snapshot] };
      await writeFile(join(directory, "project.json"), JSON.stringify(updated, null, 2));
      return json(res, 200, { project: await getProject(project.id), version: snapshot });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") return json(res, 504, { error: "AI_TIMEOUT", message: "A alteração demorou demais. Tente novamente." });
      return json(res, 502, { error: "PROJECT_MODIFY_FAILED", message: "Não foi possível modificar o projeto: " + error.message });
    }
  }
  if (projectAction && req.method === "POST" && projectAction[2] === "rollback") {
    try {
      const project = await getProject(projectAction[1]);
      if (!project) return json(res, 404, { error: "PROJECT_NOT_FOUND", message: "Projeto não encontrado." });
      const body = await bodyJson(req);
      const version = await readVersion(project.id, typeof body.versionId === "string" ? body.versionId : "");
      if (!version) return json(res, 404, { error: "VERSION_NOT_FOUND", message: "Versão não encontrada." });
      const directory = join(DATA_DIR, project.id);
      const metadata = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
      const snapshot = await createSnapshot(metadata);
      await applyProjectFiles(project.id, version.files);
      const updated = { ...metadata, title: version.title, type: version.type, files: version.files.map(file => file.path), updatedAt: new Date().toISOString(), versions: [...(metadata.versions || []), snapshot] };
      await writeFile(join(directory, "project.json"), JSON.stringify(updated, null, 2));
      return json(res, 200, { project: await getProject(project.id), version: snapshot });
    } catch (error) { return json(res, 500, { error: "ROLLBACK_FAILED", message: "Não foi possível restaurar a versão." }); }
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && projectMatch) {
    const project = await getProject(projectMatch[1]);
    return project ? json(res, 200, { project }) : json(res, 404, { error: "PROJECT_NOT_FOUND", message: "Projeto não encontrado." });
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    try { return json(res, 200, { projects: await listProjects() }); }
    catch { return json(res, 500, { error: "PROJECT_LIST_FAILED", message: "Não foi possível carregar os projetos." }); }
  }
  if (req.method === "POST" && url.pathname === "/api/projects/create") {
    try {
      const body = await bodyJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (prompt.length < 8 || prompt.length > 5000) return json(res, 400, { error: "INVALID_PROMPT", message: "O briefing deve ter entre 8 e 5.000 caracteres." });
      const generated = await generateProject(prompt);
      if (generated.status !== 200) return json(res, generated.status, generated.body);
      const project = await saveProject(generated.body);
      return json(res, 201, { project });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") return json(res, 504, { error: "AI_TIMEOUT", message: "A geração demorou demais. Tente novamente." });
      return json(res, 502, { error: "PROJECT_CREATE_FAILED", message: "Não foi possível criar o projeto: " + error.message });
    }
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
  if (url.pathname !== "/" && url.pathname !== "/index.html") return json(res, 404, { error: "NOT_FOUND", message: "Rota não encontrada." });
  try {
    const data = await readFile(join(ROOT, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch { json(res, 404, { error: "NOT_FOUND", message: "Interface não encontrada." }); }
});
server.listen(PORT, HOST, () => console.log("IA Games disponível em http://" + HOST + ":" + PORT));
