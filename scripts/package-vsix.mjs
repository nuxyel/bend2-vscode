import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function npmCliPath() {
  const configured = process.env.npm_execpath;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}

const { stdout: timestamp } = await execFileAsync("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: root });
const sourceDateEpoch = timestamp.trim();
if (!/^\d+$/.test(sourceDateEpoch)) throw new Error("Could not determine the commit timestamp for reproducible VSIX packaging.");

const result = await execFileAsync(process.execPath, [npmCliPath(), "exec", "--workspace", "apps/vscode", "--", "vsce", "package", "--no-dependencies"], {
  cwd: root,
  env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch },
  maxBuffer: 20 * 1024 * 1024,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
console.log(`Reproducible VSIX timestamp: ${sourceDateEpoch}`);
