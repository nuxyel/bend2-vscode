import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dogfoodRoot = path.join(root, "tests", "dogfood", "proof-project");
const versionsPath = path.join(root, "tests", "dogfood", "compiler-versions.json");
const versions = JSON.parse(await readFile(versionsPath, "utf8"));
const expectedVersion = process.env.BEND_DOGFOOD_VERSION ?? versions.minimum.version;
if (![versions.minimum.version, versions.latest.version].includes(expectedVersion)) {
  throw new Error(`BEND_DOGFOOD_VERSION ${expectedVersion} is not pinned in ${path.relative(root, versionsPath)}.`);
}

const localBinary = path.join(root, "node_modules", ".cache", "bend-dogfood", expectedVersion, "bend", "bin", "bend");
const executable = process.env.BEND_EXECUTABLE ?? (existsSync(localBinary) ? localBinary : "bend");
const executableArgs = process.env.BEND_EXECUTABLE_ARGS ? JSON.parse(process.env.BEND_EXECUTABLE_ARGS) : [];
if (!Array.isArray(executableArgs) || executableArgs.some((argument) => typeof argument !== "string")) {
  throw new Error("BEND_EXECUTABLE_ARGS must be a JSON array of strings.");
}
function run(args) {
  const result = spawnSync(executable, [...executableArgs, ...args], { cwd: dogfoodRoot, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`Could not run '${executable}': ${result.error.message}`);
  return result;
}

const versionResult = run(["version"]);
const reportedVersion = `${versionResult.stdout}\n${versionResult.stderr}`.match(/\b\d+\.\d+\.\d+\b/)?.[0];
if (versionResult.status !== 0 || reportedVersion !== expectedVersion) {
  throw new Error(`Dogfood requires Bend ${expectedVersion}; found ${reportedVersion ?? "no usable Bend compiler"}.`);
}

const check = run(["PROOF.bend", "--check-only"]);
const output = `${check.stdout ?? ""}${check.stderr ?? ""}`.trim();
if (check.status !== 0) throw new Error(`The verified dogfood proof failed with Bend ${expectedVersion}.\n${output}`);
console.log(`Bend ${reportedVersion} verified the dogfood proof.\n${output}`);
