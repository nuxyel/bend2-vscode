import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionOut = path.join(root, "apps", "vscode", "dist", "extension.js");
const browserOut = path.join(root, "apps", "vscode", "dist", "browser.js");
const browserWorkerOut = path.join(root, "apps", "vscode", "dist", "browserWorker.js");
const serverDir = path.join(root, "apps", "vscode", "server");
const serverOut = path.join(serverDir, "server.js");

await rm(serverDir, { recursive: true, force: true });
await mkdir(path.dirname(extensionOut), { recursive: true });
await mkdir(serverDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "apps", "vscode", "src", "extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  outfile: extensionOut,
  sourcemap: true,
});

await build({
  entryPoints: [path.join(root, "apps", "vscode", "src", "browser.ts")],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["vscode"],
  outfile: browserOut,
  sourcemap: true,
});

await build({
  entryPoints: [path.join(root, "apps", "vscode", "src", "browserWorker.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: browserWorkerOut,
  sourcemap: true,
});

await build({
  entryPoints: [path.join(root, "packages", "language-server", "src", "server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: serverOut,
  sourcemap: true,
});

console.log(`Bundled VS Code client: ${path.relative(root, extensionOut)}`);
console.log(`Bundled VS Code web client: ${path.relative(root, browserOut)}`);
console.log(`Bundled VS Code browser worker: ${path.relative(root, browserWorkerOut)}`);
console.log(`Bundled language server: ${path.relative(root, serverOut)}`);
