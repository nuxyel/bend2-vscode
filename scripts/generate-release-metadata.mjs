import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "artifacts", "release");
const manifest = JSON.parse(await readFile(path.join(root, "apps", "vscode", "package.json"), "utf8"));
const project = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
async function command(commandName, args) {
  const result = await execFileAsync(commandName, args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  return result.stdout.trim();
}

async function npmCommand(args) {
  if (process.platform !== "win32") return command("npm", args);
  const configuredCli = process.env.npm_execpath;
  const npmCli = configuredCli && path.isAbsolute(configuredCli)
    ? configuredCli
    : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return command(process.execPath, [npmCli, ...args]);
}

await mkdir(outputDirectory, { recursive: true });
const sbom = JSON.parse(await npmCommand(["sbom", "--sbom-format", "cyclonedx", "--sbom-type", "application", "--package-lock-only"]));
if (!sbom.metadata?.component) throw new Error("CycloneDX SBOM is missing its root project component.");
sbom.metadata.component.name = project.name;
sbom.metadata.component.version = manifest.version;
const commit = await command("git", ["rev-parse", "HEAD"]);
const commitTimestamp = await command("git", ["show", "-s", "--format=%cI", "HEAD"]);
const sourceDateEpoch = await command("git", ["show", "-s", "--format=%ct", "HEAD"]);
const vsixName = (await readdir(path.join(root, "apps", "vscode"))).find((name) => name.endsWith(".vsix"));
if (!vsixName) throw new Error("No VSIX found. Run npm run package first.");
const vsixPath = path.join(root, "apps", "vscode", vsixName);
const vsixHash = createHash("sha256").update(await readFile(vsixPath)).digest("hex");
const provenance = {
  schemaVersion: 1,
  artifact: { name: vsixName, version: manifest.version, sha256: vsixHash },
  source: {
    repository: manifest.repository?.url ?? "https://github.com/nuxyel/bend2-vscode",
    commit,
    commitTimestamp,
  },
  build: { node: process.version, npm: await npmCommand(["--version"]), platform: process.platform, arch: process.arch, sourceDateEpoch },
};
const prefix = `bend2-vscode-${manifest.version}`;
await writeFile(path.join(outputDirectory, `${prefix}.cdx.json`), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDirectory, `${prefix}.provenance.json`), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
console.log(`Wrote release metadata for ${vsixName}: SBOM and provenance.`);
