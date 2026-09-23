import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-web";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repositoryRoot, "apps", "vscode");

await runTests({
  browserType: "chromium",
  quality: "stable",
  extensionDevelopmentPath: extensionPath,
  extensionTestsPath: path.join(extensionPath, "web-test.cjs"),
  folderPath: repositoryRoot,
  headless: true,
  verbose: true,
});
