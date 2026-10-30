import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { Script } from "node:vm";

const port = 4317 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", AI_API_KEY: "", AI_MODEL: "" },
  stdio: "ignore"
});
let ready = false;
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(origin + "/api/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(150);
  }
  assert.equal(ready, true, "server starts and exposes health endpoint");

  const health = await (await fetch(origin + "/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.aiConfigured, false);
  assert.deepEqual(health.providers, []);
  const providerList = await (await fetch(origin + "/api/providers")).json();
  assert.deepEqual(providerList.providers, []);
  assert.equal(Object.hasOwn(health, "apiKey"), false);

  const home = await fetch(origin + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /IA Games/);
  const scriptStart = html.indexOf("<script>");
  const scriptEnd = html.lastIndexOf("</script>");
  assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "studio page contains its client script");
  new Script(html.slice(scriptStart + 8, scriptEnd), { filename: "index.html" });

  const projects = await (await fetch(origin + "/api/projects")).json();
  assert.ok(Array.isArray(projects.projects));

  const invalid = await fetch(origin + "/api/projects/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "curto" })
  });
  assert.equal(invalid.status, 400);

  const unconfigured = await fetch(origin + "/api/projects/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Crie um jogo de plataforma simples." })
  });
  assert.equal(unconfigured.status, 503);

  const versionsWithoutProject = await fetch(origin + "/api/projects/00000000-0000-0000-0000-000000000000/versions");
  assert.equal(versionsWithoutProject.status, 404);
  const modifyWithoutProject = await fetch(origin + "/api/projects/00000000-0000-0000-0000-000000000000/modify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Mude o título do projeto." }) });
  assert.equal(modifyWithoutProject.status, 404);

  const hidden = await fetch(origin + "/.env");
  assert.equal(hidden.status, 404);
  const data = await fetch(origin + "/.iagames-data/projects");
  assert.equal(data.status, 404);
  const missingProject = await fetch(origin + "/api/projects/00000000-0000-0000-0000-000000000000");
  assert.equal(missingProject.status, 404);

  console.log("Smoke tests passed: health, static UI, project listing, prompt validation, missing AI config and private-file protection.");
} finally {
  child.kill("SIGTERM");
}
