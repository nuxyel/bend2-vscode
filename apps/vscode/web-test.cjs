const vscode = require("vscode");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const extension = vscode.extensions.getExtension("nuxyel.bend2-vscode");
  assert(extension, "Bend 2 extension was not discovered by the web host.");
  await extension.activate();

  const languages = await vscode.languages.getLanguages();
  assert(languages.includes("bend"), "Bend language was not registered in the web host.");

  const document = await vscode.workspace.openTextDocument({
    language: "bend",
    content: "def main():\n  ?TODO\n",
  });
  await vscode.window.showTextDocument(document);

  const symbols = await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    document.uri,
  );
  assert(Array.isArray(symbols) && symbols.some((symbol) => symbol.name === "main"), "The web symbol provider did not find main.");
  const folding = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", document.uri);
  assert(Array.isArray(folding), "The web folding provider did not return folding ranges.");

  const completions = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    document.uri,
    new vscode.Position(0, 4),
  );
  assert(completions?.items?.some((item) => item.label === "main"), "The web completion provider did not return the local symbol.");
  const hovers = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    document.uri,
    new vscode.Position(0, 6),
  );
  assert(Array.isArray(hovers) && hovers.length > 0, "The web hover provider did not return local symbol information.");
  const hoverText = hovers.flatMap((hover) => hover.contents ?? []).map((content) => typeof content === "string" ? content : content.value ?? String(content)).join("\n");
  assert(/def main\(\)/.test(hoverText), `The web hover did not include the complete declaration: ${hoverText}`);
  const localReferences = await vscode.commands.executeCommand(
    "vscode.executeReferenceProvider",
    document.uri,
    new vscode.Position(0, 6),
  );
  assert(Array.isArray(localReferences) && localReferences.length >= 1, "The web reference provider did not include the open non-workspace document.");

  await new Promise((resolve) => setTimeout(resolve, 100));
  const diagnostics = vscode.languages.getDiagnostics(document.uri);
  assert(diagnostics.some((diagnostic) => diagnostic.source === "Bend 2 web parser"), "The web parser did not publish diagnostics.");

  const fixtureRoot = vscode.Uri.parse("vscode-test-web://mount/web-fixtures");
  const libraryUri = vscode.Uri.joinPath(fixtureRoot, "library.bend");
  const consumerUri = vscode.Uri.joinPath(fixtureRoot, "consumer.bend");
  await vscode.workspace.fs.createDirectory(fixtureRoot);
  await vscode.workspace.fs.writeFile(libraryUri, new TextEncoder().encode("type Option:\n  Some { value }\ndef helper(value: Nat):\n  value\n"));
  await vscode.workspace.fs.writeFile(consumerUri, new TextEncoder().encode("import ./library.bend as Library\ndef consumer(x: Option):\n  helper\n"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(libraryUri), "bend");
  const consumer = await vscode.workspace.openTextDocument(consumerUri);
  await vscode.languages.setTextDocumentLanguage(consumer, "bend");
  const workspaceSymbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "helper");
  assert(Array.isArray(workspaceSymbols) && workspaceSymbols.some((symbol) => symbol.name === "helper"), "The web workspace symbol provider did not index the virtual workspace.");
  const definition = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    consumer.uri,
    new vscode.Position(2, 3),
  );
  assert(Array.isArray(definition) && definition.some((location) => location.uri.toString() === libraryUri.toString()), "The web definition provider did not resolve a cross-file symbol.");
  const typeDefinition = await vscode.commands.executeCommand(
    "vscode.executeTypeDefinitionProvider",
    consumer.uri,
    new vscode.Position(1, 18),
  );
  assert(Array.isArray(typeDefinition) && typeDefinition.some((location) => location.uri.toString() === libraryUri.toString()), "The web type-definition provider did not resolve the cross-file type.");

  const workspaceCompletions = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    consumer.uri,
    new vscode.Position(2, 8),
  );
  assert(workspaceCompletions?.items?.some((item) => item.label === "helper"), "The web completion provider did not return the cross-file symbol.");
  const workspaceHovers = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    consumer.uri,
    new vscode.Position(2, 5),
  );
  assert(Array.isArray(workspaceHovers) && workspaceHovers.length > 0, "The web hover provider did not return the cross-file symbol.");
  const workspaceHoverText = workspaceHovers.flatMap((hover) => hover.contents ?? []).map((content) => typeof content === "string" ? content : content.value ?? String(content)).join("\n");
  assert(/helper\(value: Nat\)/.test(workspaceHoverText), `The web cross-file hover did not include the declaration: ${workspaceHoverText}`);

  const references = await vscode.commands.executeCommand(
    "vscode.executeReferenceProvider",
    consumer.uri,
    new vscode.Position(2, 5),
  );
  assert(Array.isArray(references) && references.length >= 2, "The web reference provider did not return cross-file references.");
  const rename = await vscode.commands.executeCommand(
    "vscode.executeDocumentRenameProvider",
    consumer.uri,
    new vscode.Position(2, 5),
    "renamed",
  );
  assert(rename && JSON.stringify(rename).includes("renamed"), "The web rename provider did not return a workspace edit.");
}

module.exports = { run };
