const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const expectedCommands = [
  "bend2.checkFile",
  "bend2.checkWorkspace",
  "bend2.runProjectGate",
  "bend2.runSabotage",
  "bend2.buildFile",
  "bend2.runFile",
  "bend2.probeBackend",
  "bend2.benchmarkFile",
  "bend2.showBase",
  "bend2.showVersion",
  "bend2.showExecutionEnvironment",
  "bend2.refreshProofExplorer",
  "bend2.compareBackends",
  "bend2.compareProjectBackends",
  "bend2.showProofDetails",
  "bend2.showProofGoal",
  "bend2.checkProof",
  "bend2.reviewLawChanges",
  "bend2.copySupportDiagnostics",
];

suite("Bend 2 extension", () => {
  test("activates and registers the public command surface", async () => {
    const extension = vscode.extensions.getExtension("nuxyel.bend2-vscode");
    assert.ok(extension, "Bend 2 extension was not discovered by the host.");
    await extension.activate();
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of expectedCommands) assert.ok(commands.has(command), `Missing command: ${command}`);
    assert.ok((await vscode.languages.getLanguages()).includes("bend"), "Bend language was not registered.");
  });

  test("opens the repository dogfood project with imported Bend editor features", async function () {
    this.timeout(10000);
    if (process.env.BEND2_DOGFOOD_REQUIRED === "true" && process.env.BEND_EXECUTABLE) {
      const settings = vscode.workspace.getConfiguration("bend2");
      await settings.update("executablePath", process.env.BEND_EXECUTABLE, vscode.ConfigurationTarget.Global);
      if (process.env.BEND_EXECUTABLE_ARGS) {
        const executableArgs = JSON.parse(process.env.BEND_EXECUTABLE_ARGS);
        assert.ok(Array.isArray(executableArgs) && executableArgs.every((argument) => typeof argument === "string"), "BEND_EXECUTABLE_ARGS must be a JSON array of strings.");
        await settings.update("executableArgs", executableArgs, vscode.ConfigurationTarget.Global);
      }
    }
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const expectedWorkspace = path.resolve(__dirname, "..", "tests", "dogfood", "proof-project");
    assert.equal(path.resolve(workspace ?? ""), expectedWorkspace, "The desktop smoke test must open the maintained Bend dogfood project.");
    const appFile = path.join(expectedWorkspace, "app.bend");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(appFile));
    await vscode.window.showTextDocument(document);
    const callPosition = new vscode.Position(4, 22);
    const deadline = Date.now() + 5000;
    let signature;
    let definition;
    do {
      signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", document.uri, callPosition, "(");
      definition = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, new vscode.Position(4, 9));
      if (signature?.signatures?.length && Array.isArray(definition) && definition.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.match(signature?.signatures?.[0]?.label ?? "", /add_zero\(value: Nat\)/);
    assert.ok(definition.some((location) => location.uri.fsPath === path.join(expectedWorkspace, "main.bend")), "Imported Go to Definition did not open the dogfood module.");

    if (process.env.BEND2_DOGFOOD_REQUIRED === "true") {
      const lawFile = vscode.Uri.file(path.join(expectedWorkspace, "LAWS.bend"));
      const proofFile = vscode.Uri.file(path.join(expectedWorkspace, "PROOF.bend"));
      const proofPassed = await vscode.commands.executeCommand("bend2.checkProof", lawFile.toString(), "adding_zero_preserves_value");
      assert.equal(proofPassed, true, "The extension did not complete a successful compiler-backed check for the dogfood proof.");
      const errors = vscode.languages.getDiagnostics(proofFile).filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
      assert.deepEqual(errors, [], "The extension published errors for the compiler-verified dogfood proof.");
    }
  });

  test("provides symbols and parser diagnostics for an opened Bend file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-vscode-integration-"));
    const file = path.join(root, "main.bend");
    await fs.writeFile(file, "def main():\n  ?TODO\ndef main():\n  0\n");
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      const deadline = Date.now() + 5000;
      let symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
      while ((!Array.isArray(symbols) || !symbols.some((symbol) => symbol.name === "main")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
      }
      assert.ok(Array.isArray(symbols) && symbols.some((symbol) => symbol.name === "main"), "The language server did not return the main symbol.");
      let diagnostics = vscode.languages.getDiagnostics(document.uri);
      while (diagnostics.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        diagnostics = vscode.languages.getDiagnostics(document.uri);
      }
      assert.ok(diagnostics.some((diagnostic) => /Open proof goal|Duplicate declaration/.test(diagnostic.message)), "The language server did not publish parser diagnostics.");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });

  test("keeps incomplete and large Bend files responsive in the host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-vscode-fixtures-"));
    const file = path.join(root, "large-incomplete.bend");
    const source = "def incomplete(x:\n  ?TODO\n" + Array.from({ length: 350 }, (_, index) => `def generated${index}():\n  0\n`).join("");
    await fs.writeFile(file, source);
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      const deadline = Date.now() + 5000;
      let symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
      while ((!Array.isArray(symbols) || !symbols.some((symbol) => symbol.name === "generated349")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
      }
      assert.ok(Array.isArray(symbols) && symbols.some((symbol) => symbol.name === "generated349"), "The language server did not index the end of the large fixture.");
      let diagnostics = vscode.languages.getDiagnostics(document.uri);
      while (diagnostics.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        diagnostics = vscode.languages.getDiagnostics(document.uri);
      }
      assert.ok(diagnostics.some((diagnostic) => /Open proof goal/.test(diagnostic.message)), "The language server did not preserve diagnostics for the incomplete fixture.");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });

  test("serves references, rename and type definition through the LSP", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-vscode-navigation-"));
    const file = path.join(root, "navigation.bend");
    await fs.writeFile(file, "type Option:\n  Some { value }\ndef helper(value: Nat):\n  value\ndef main(x: Option):\n  helper(0)\n");
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      const helperCall = new vscode.Position(5, 2);
      const deadline = Date.now() + 5000;
      let references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", document.uri, helperCall);
      while ((!Array.isArray(references) || references.length < 2) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", document.uri, helperCall);
      }
      assert.ok(Array.isArray(references) && references.length >= 2, "The language server did not return helper references.");

      const rename = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", document.uri, new vscode.Position(2, 4), "renamed");
      assert.ok(rename && JSON.stringify(rename).includes("renamed"), "The language server did not return a rename workspace edit.");

      const typeDefinitions = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", document.uri, new vscode.Position(4, 13));
      assert.ok(Array.isArray(typeDefinitions) && typeDefinitions.some((location) => location.uri.toString() === document.uri.toString()), "The language server did not resolve the Option type definition.");

      const hierarchy = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", document.uri, new vscode.Position(2, 4));
      assert.ok(Array.isArray(hierarchy) && hierarchy.some((item) => item.name === "helper"), "The language server did not prepare a helper call hierarchy item.");
      const helperItem = hierarchy.find((item) => item.name === "helper");
      const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", helperItem);
      assert.ok(Array.isArray(incoming) && incoming.some((call) => call.from?.name === "main"), "The language server did not return incoming calls for helper.");

      const mainHierarchy = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", document.uri, new vscode.Position(4, 4));
      const mainItem = Array.isArray(mainHierarchy) ? mainHierarchy.find((item) => item.name === "main") : undefined;
      const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", mainItem);
      assert.ok(Array.isArray(outgoing) && outgoing.some((call) => call.to?.name === "helper"), "The language server did not return outgoing calls for main.");

      const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, helperCall);
      assert.ok(Array.isArray(completions?.items) && completions.items.some((item) => item.label === "helper"), "The language server did not return helper completion.");

      const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", document.uri, helperCall);
      assert.ok(Array.isArray(hovers) && hovers.length > 0, "The language server did not return hover information.");
      const hoverText = hovers.flatMap((hover) => hover.contents ?? []).map((content) => typeof content === "string" ? content : content.value ?? String(content)).join("\n");
      assert.match(hoverText, /helper\(value: Nat\)/, `The hover did not include the complete Bend declaration: ${hoverText}`);

      const edits = await vscode.commands.executeCommand(
        "vscode.executeFormatDocumentProvider",
        document.uri,
        { tabSize: 2, insertSpaces: true },
      );
      assert.ok(Array.isArray(edits), "The language server did not return document formatting edits.");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });

  test("provides local and imported function signatures with active parameters", async function () {
    this.timeout(10000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-vscode-signature-"));
    const library = path.join(root, "lib.bend");
    const main = path.join(root, "main.bend");
    await fs.writeFile(library, "def imported(first: Nat, second: List(Nat)):\n  first\n");
    await fs.writeFile(main, "import ./lib.bend as Lib\ndef local(a: Nat, b: Option((Nat, Nat))):\n  a\ndef main():\n  local(0, )\n  Lib.imported(0, )\n");
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
      await vscode.window.showTextDocument(document);
      const deadline = Date.now() + 5000;
      let localHelp;
      let importedHelp;
      do {
        localHelp = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", document.uri, new vscode.Position(4, 11), ",");
        importedHelp = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", document.uri, new vscode.Position(5, 18), ",");
        if (localHelp?.signatures?.length && importedHelp?.signatures?.length) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.match(localHelp?.signatures?.[0]?.label ?? "", /local\(a: Nat, b: Option\(\(Nat, Nat\)\)\)/);
      assert.equal(localHelp?.activeParameter, 1);
      assert.match(importedHelp?.signatures?.[0]?.label ?? "", /imported\(first: Nat, second: List\(Nat\)\)/);
      assert.equal(importedHelp?.activeParameter, 1);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });
});
