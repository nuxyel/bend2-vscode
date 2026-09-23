import { readFile, stat } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientPath = path.join(root, "apps", "vscode", "dist", "extension.js");
const serverPath = path.join(root, "apps", "vscode", "server", "server.js");
const browserPath = path.join(root, "apps", "vscode", "dist", "browser.js");
const browserWorkerPath = path.join(root, "apps", "vscode", "dist", "browserWorker.js");
const client = await readFile(clientPath, "utf8");
const server = await readFile(serverPath, "utf8");
const browser = await readFile(browserPath, "utf8");
const browserWorker = await readFile(browserWorkerPath, "utf8");

if (client.includes('require("vscode-languageclient/node")')) {
  throw new Error("The VS Code client still has an unbundled language-client dependency.");
}
if (server.includes('from "vscode-languageserver')) {
  throw new Error("The language server still has an unbundled LSP dependency.");
}
if (!client.includes('require("vscode")')) {
  throw new Error("The VS Code client no longer exposes the VS Code runtime boundary.");
}
if ((await stat(serverPath)).size < 100_000) {
  throw new Error("The bundled language server is unexpectedly small.");
}
if (browser.includes("node:child_process") || browser.includes("node:fs")) {
  throw new Error("The VS Code web client contains a Node-only dependency.");
}
if (browserWorker.includes("node:child_process") || browserWorker.includes("node:fs") || !browserWorker.includes("postMessage")) {
  throw new Error("The browser worker contains a Node-only dependency or no message handler.");
}
const workerMessages = [];
const workerSelf = { postMessage: (message) => workerMessages.push(message) };
vm.runInNewContext(browserWorker, { self: workerSelf });
if (typeof workerSelf.onmessage !== "function") throw new Error("The browser worker did not register a message handler.");
workerSelf.onmessage({ data: { id: 1, method: "index", files: [{ uri: "file:///main.bend", text: "def main():\n  0\n" }] } });
workerSelf.onmessage({ data: { id: 2, method: "symbols", query: "main" } });
const workerResponse = workerMessages.find((message) => message.id === 2);
if (!workerResponse?.ok || workerResponse.value?.[0]?.name !== "main") {
  throw new Error("The bundled browser worker failed its index/symbol protocol smoke test.");
}
if (!browser.includes("registerDocumentFormattingEditProvider") || !browser.includes("registerDocumentSymbolProvider") || !browser.includes("registerFoldingRangeProvider") || !browser.includes("registerDocumentSemanticTokensProvider") || !browser.includes("registerDefinitionProvider") || !browser.includes("registerTypeDefinitionProvider") || !browser.includes("registerDocumentLinkProvider") || !browser.includes("registerReferenceProvider") || !browser.includes("registerRenameProvider") || !browser.includes("registerWorkspaceSymbolProvider") || !browser.includes("registerCompletionItemProvider") || !browser.includes("registerHoverProvider") || !browser.includes("createDiagnosticCollection") || !browser.includes("SymbolKind.Constructor")) {
  throw new Error("The VS Code web client no longer exposes formatting support.");
}

console.log("Bundle smoke test passed: runtime dependencies are self-contained.");
