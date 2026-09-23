import * as path from "node:path";
import * as vscode from "vscode";
import { BendToolchain, CompilerDiagnostic, DiagnosticsMode } from "@bend2/toolchain";
import { groupTestCases, TestRunSelection } from "./testRunPlan.js";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function hasProjectGate(root: string): Promise<boolean> {
  for (const name of ["check.sh", "check.ps1", "check.cmd"]) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, "scripts", name)));
      return true;
    } catch {
      // Try the next conventional gate filename.
    }
  }
  return false;
}

function adapter(): BendToolchain | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  const settings = vscode.workspace.getConfiguration("bend2");
  return new BendToolchain({
    workspaceRoot: root,
    executablePath: settings.get<string>("executablePath", "bend"),
    executableArgs: settings.get<string[]>("executableArgs", []),
    diagnosticsMode: settings.get<DiagnosticsMode>("diagnosticsMode", "auto"),
  });
}

function diagnosticMessage(diagnostic: CompilerDiagnostic): vscode.TestMessage {
  const message = new vscode.TestMessage(`${diagnostic.severity}: ${diagnostic.message}`);
  const file = path.isAbsolute(diagnostic.file) ? diagnostic.file : path.join(workspaceRoot() ?? "", diagnostic.file);
  message.location = new vscode.Location(vscode.Uri.file(file), new vscode.Range(
    diagnostic.line,
    diagnostic.column,
    diagnostic.endLine ?? diagnostic.line,
    diagnostic.endColumn ?? diagnostic.column + 1,
  ));
  return message;
}

export function registerProofTests(context: vscode.ExtensionContext): void {
  const controller = vscode.tests.createTestController("bend2.proofTests", "Bend 2 Proofs");
  const lawTargets = new Map<string, vscode.Uri>();
  const refresh = async (): Promise<void> => {
    const root = workspaceRoot();
    const files = await vscode.workspace.findFiles("**/PROOF.bend", "**/node_modules/**");
    const next = new Map<string, { uri: vscode.Uri; label: string; laws?: Array<{ name: string; uri: vscode.Uri }> }>();
    lawTargets.clear();
    if (root && await hasProjectGate(root)) next.set(`bend2:gate:${root}`, { uri: vscode.Uri.file(root), label: "Project Gate" });
    for (const file of files) {
      const lawFile = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(file.fsPath)), "LAWS.bend");
      const laws: Array<{ name: string; uri: vscode.Uri }> = [];
      try {
        const source = Buffer.from(await vscode.workspace.fs.readFile(lawFile)).toString("utf8");
        for (const match of source.matchAll(/^\s*law\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) laws.push({ name: match[1], uri: lawFile });
      } catch {
        // A proof file can exist before its law specification is added.
      }
      next.set(file.toString(), { uri: file, label: `Check ${vscode.workspace.asRelativePath(file)}`, laws });
    }
    controller.items.forEach((item) => {
      if (!next.has(item.id)) controller.items.delete(item.id);
    });
    for (const [id, entry] of next) {
      const item = controller.items.get(id) ?? controller.createTestItem(id, entry.label, entry.uri);
      item.canResolveChildren = Boolean(entry.laws?.length);
      item.description = entry.laws?.length ? `${entry.laws.length} law cases; checks containing PROOF.bend` : undefined;
      while (item.children.size > 0) item.children.forEach((child) => item.children.delete(child.id));
      for (const law of entry.laws ?? []) {
        const lawId = `bend2:law:${encodeURIComponent(entry.uri.toString())}:${law.name}`;
        const child = controller.createTestItem(lawId, `Law ${law.name}`, law.uri);
        child.description = "Runs the containing PROOF.bend";
        item.children.add(child);
        lawTargets.set(lawId, entry.uri);
      }
      controller.items.add(item);
    }
  };

  controller.createRunProfile("Bend 2 project checks", vscode.TestRunProfileKind.Run, async (request, cancellationToken) => {
    const run = controller.createTestRun(request);
    const abort = new AbortController();
    const cancellation = cancellationToken.onCancellationRequested(() => abort.abort());
    try {
      const adapterInstance = adapter();
      if (!adapterInstance) {
        for (const item of request.include ?? []) run.errored(item, new vscode.TestMessage("Open a Bend 2 workspace first."));
        return;
      }
      const selected = request.include ?? (() => {
        const items: vscode.TestItem[] = [];
        controller.items.forEach((item) => items.push(item));
        return items;
      })();
      const proofTargets = new Map<string, vscode.Uri>();
      const proofSelections: Array<TestRunSelection<vscode.TestItem>> = [];
      for (const item of selected) {
        if (cancellationToken.isCancellationRequested || !item.uri) break;
        if (item.id.startsWith("bend2:gate:")) {
          run.started(item);
          const result = await adapterInstance.runGate("check", undefined, abort.signal);
          if (result.code === 0) run.passed(item);
          else if (result.cancelled) run.skipped(item);
          else if (result.diagnostics.length > 0) run.failed(item, result.diagnostics.map(diagnosticMessage));
          else run.failed(item, new vscode.TestMessage([result.stdout, result.stderr].filter(Boolean).join("\n") || "Bend 2 project gate failed."));
          continue;
        }
        const proofUri = item.id.startsWith("bend2:law:") ? lawTargets.get(item.id) : item.uri;
        if (!proofUri) {
          run.errored(item, new vscode.TestMessage("The containing PROOF.bend could not be resolved."));
          continue;
        }
        const key = proofUri.toString();
        proofTargets.set(key, proofUri);
        const children: vscode.TestItem[] = [];
        if (!item.id.startsWith("bend2:law:")) item.children.forEach((child) => children.push(child));
        proofSelections.push({
          key,
          item,
          children: children.length > 0 ? children : undefined,
        });
      }

      for (const [key, casesSet] of groupTestCases(proofSelections)) {
        if (cancellationToken.isCancellationRequested) break;
        const cases = [...casesSet];
        for (const testCase of cases) run.started(testCase);
        const result = await adapterInstance.check(proofTargets.get(key)!.fsPath, abort.signal);
        for (const testCase of cases) {
          if (result.code === 0) run.passed(testCase);
          else if (result.cancelled) run.skipped(testCase);
          else if (result.diagnostics.length > 0) run.failed(testCase, result.diagnostics.map(diagnosticMessage));
          else run.failed(testCase, new vscode.TestMessage([result.stdout, result.stderr].filter(Boolean).join("\n") || "Bend 2 check failed."));
        }
      }
    } finally {
      cancellation.dispose();
      run.end();
    }
  }, true);

  const watcher = vscode.workspace.createFileSystemWatcher("**/PROOF.bend", false, false, false);
  const lawWatcher = vscode.workspace.createFileSystemWatcher("**/LAWS.bend", false, false, false);
  const gateWatcher = vscode.workspace.createFileSystemWatcher("**/scripts/check.*", false, false, false);
  context.subscriptions.push(
    controller,
    watcher,
    lawWatcher,
    gateWatcher,
    watcher.onDidCreate(() => void refresh()),
    watcher.onDidChange(() => void refresh()),
    watcher.onDidDelete(() => void refresh()),
    lawWatcher.onDidCreate(() => void refresh()),
    lawWatcher.onDidChange(() => void refresh()),
    lawWatcher.onDidDelete(() => void refresh()),
    gateWatcher.onDidCreate(() => void refresh()),
    gateWatcher.onDidChange(() => void refresh()),
    gateWatcher.onDidDelete(() => void refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
  );
  void refresh();
}
