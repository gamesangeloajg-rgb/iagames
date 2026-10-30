import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

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
  assert.equal(Object.hasOwn(health, "apiKey"), false);

  const home = await fetch(origin + "/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /IA Games/);

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

  const hidden = await fetch(origin + "/.env");
  assert.equal(hidden.status, 404);
  const data = await fetch(origin + "/.iagames-data/projects");
  assert.equal(data.status, 404);

  console.log("Smoke tests passed: health, static UI, project listing, prompt validation, missing AI config and private-file protection.");
} finally {
  child.kill("SIGTERM");
}
