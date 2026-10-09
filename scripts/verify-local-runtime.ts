import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const imported = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    "await import('./dist/app.js'); console.log('APP_IMPORT_OK');",
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let importOutput = "";
imported.stdout.on("data", (chunk) => {
  importOutput += String(chunk);
});
const importTimer = setTimeout(() => imported.kill(), 5000);
const importCode = await new Promise<number | null>((resolve) =>
  imported.once("exit", resolve),
);
clearTimeout(importTimer);
if (importCode !== 0 || !importOutput.includes("APP_IMPORT_OK"))
  throw new Error("App import did not exit cleanly without a listener");
console.log("App import: exited cleanly, no listener");
const port = "4401";
const server = spawn(process.execPath, ["dist/server.js"], {
  env: { ...process.env, PORT: port },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  let ready = false;
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("Endpoint API listening")) ready = true;
  });
  for (let attempt = 0; attempt < 90 && !ready; attempt++) {
    if (server.exitCode !== null)
      throw new Error("Local server exited before readiness");
    await delay(500);
  }
  if (!ready)
    throw new Error("Local server did not become ready within 45 seconds");
  for (const endpoint of ["/health", "/api/v1/health"]) {
    const response = await fetch(`http://localhost:${port}${endpoint}`);
    if (!response.ok) throw new Error(`Health failed: ${response.status}`);
    console.log(
      JSON.stringify({
        endpoint,
        status: response.status,
        body: await response.json(),
      }),
    );
  }
} finally {
  server.kill();
}
