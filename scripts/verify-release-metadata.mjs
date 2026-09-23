import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "apps", "vscode", "package.json"), "utf8"));
const releaseDirectory = path.join(root, "artifacts", "release");
const prefix = `bend2-vscode-${manifest.version}`;
const vsixPath = path.join(root, "apps", "vscode", `${prefix}.vsix`);
const provenancePath = path.join(releaseDirectory, `${prefix}.provenance.json`);
const sbomPath = path.join(releaseDirectory, `${prefix}.cdx.json`);

const [provenance, sbom, vsix] = await Promise.all([
  readFile(provenancePath, "utf8").then(JSON.parse),
  readFile(sbomPath, "utf8").then(JSON.parse),
  readFile(vsixPath),
]);
const expectedHash = createHash("sha256").update(vsix).digest("hex");
const { stdout: commitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
const commit = commitOutput.trim();

if (provenance.schemaVersion !== 1) throw new Error("Release provenance schemaVersion must be 1.");
if (provenance.artifact?.name !== `${prefix}.vsix` || provenance.artifact?.version !== manifest.version) {
  throw new Error("Release provenance artifact metadata does not match the extension manifest.");
}
if (provenance.artifact.sha256 !== expectedHash) {
  throw new Error(`Release provenance hash does not match the VSIX: ${provenance.artifact.sha256} != ${expectedHash}`);
}
if (provenance.source?.commit !== commit) throw new Error("Release provenance does not describe the current commit.");
if (provenance.source?.repository !== manifest.repository?.url) throw new Error("Release provenance repository does not match the extension manifest.");
if (sbom.bomFormat !== "CycloneDX" || sbom.metadata?.component?.name !== manifest.name || sbom.metadata?.component?.version !== manifest.version) {
  throw new Error("CycloneDX SBOM metadata does not match the extension manifest.");
}

console.log(`Release metadata passed: ${prefix} (${expectedHash}).`);
