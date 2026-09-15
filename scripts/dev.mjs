#!/usr/bin/env node
/**
 * Dev loop: rebuild on change and serve the fixture app on one port.
 *
 *   npm run dev            # build --watch + http://localhost:9283/examples/vanilla/
 *   npm run dev -- --port 9284
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? process.argv[portIndex + 1] : "9283";

const children = [];

function run(label, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal !== "SIGTERM" && signal !== "SIGINT" && code !== 0) {
      console.error(`[dev] ${label} exited with code ${code}`);
    }
  });
  children.push(child);
  return child;
}

run("build", [join(root, "scripts/build.mjs"), "--watch"]);
run("serve", [join(root, "scripts/serve-example.mjs"), "--port", port]);

const shutdown = () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[dev] fixture: http://localhost:${port}/examples/vanilla/`);
