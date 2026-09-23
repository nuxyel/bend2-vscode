import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDevelopmentPath = path.join(root, "apps", "vscode");
const extensionTestsPath = path.join(root, "scripts", "extension-smoke.cjs");
const version = process.env.VSCODE_VERSION ?? "stable";

console.log(`Running VS Code integration smoke test (${version}).`);
await runTests({
  version,
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: ["--disable-gpu", "--disable-extensions-except", extensionDevelopmentPath],
});
