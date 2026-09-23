import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "apps", "vscode", "package.json"), "utf8"));
const vsixPath = path.join(root, "apps", "vscode", `bend2-vscode-${manifest.version}.vsix`);

function npmCliPath() {
  const configured = process.env.npm_execpath;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}

async function packageOnce() {
  await execFileAsync(process.execPath, [npmCliPath(), "run", "package", "--workspace", "apps/vscode"], {
    cwd: root,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return createHash("sha256").update(await readFile(vsixPath)).digest("hex");
}

const first = await packageOnce();
const second = await packageOnce();
if (first !== second) throw new Error(`VSIX is not reproducible: ${first} != ${second}`);
console.log(`Reproducible VSIX verified: ${second}`);
