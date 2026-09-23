import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedVersion = process.argv[2];
if (!requestedVersion) throw new Error("Usage: node scripts/install-dogfood-compiler.mjs <pinned-version>");
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The pinned dogfood compiler installer currently supports Linux x64 CI runners only.");
}

const pins = JSON.parse(await readFile(path.join(root, "tests", "dogfood", "compiler-versions.json"), "utf8"));
const pin = [pins.minimum, pins.latest].find((entry) => entry.version === requestedVersion);
if (!pin) throw new Error(`Bend ${requestedVersion} is not pinned as the minimum or latest dogfood compiler version.`);
if (!/^[a-f0-9]{64}$/i.test(pin.linuxX64Sha256)) throw new Error(`Invalid Linux x64 SHA-256 pin for Bend ${requestedVersion}.`);

const cacheRoot = path.join(root, "node_modules", ".cache", "bend-dogfood", requestedVersion);
const binary = path.join(cacheRoot, "bend", "bin", "bend");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bend2-dogfood-"));
const archive = path.join(tempRoot, `bend-${requestedVersion}-linux-x64.tar.gz`);
const url = `https://github.com/bendlang/bend/releases/download/v${requestedVersion}/bend-${requestedVersion}-linux-x64.tar.gz`;

try {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download Bend ${requestedVersion}: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash.toLowerCase() !== pin.linuxX64Sha256.toLowerCase()) {
    throw new Error(`Bend ${requestedVersion} checksum mismatch: expected ${pin.linuxX64Sha256}, received ${actualHash}.`);
  }

  await rm(cacheRoot, { recursive: true, force: true });
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(archive, bytes);
  await execFileAsync("tar", ["-xzf", archive, "-C", cacheRoot]);
  const versionResult = await execFileAsync(binary, ["version"]);
  const reportedVersion = `${versionResult.stdout}\n${versionResult.stderr}`.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (reportedVersion !== requestedVersion) {
    await rm(cacheRoot, { recursive: true, force: true });
    throw new Error(`Downloaded Bend reports ${reportedVersion ?? "an unknown version"}; expected ${requestedVersion}.`);
  }

  if (process.env.GITHUB_PATH) await appendFile(process.env.GITHUB_PATH, `${path.dirname(binary)}${os.EOL}`);
  console.log(`Installed checksum-verified Bend ${reportedVersion} at ${binary}`);
} catch (error) {
  await rm(cacheRoot, { recursive: true, force: true });
  throw error;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
