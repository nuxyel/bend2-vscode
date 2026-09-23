import * as vscode from "vscode";
import * as path from "node:path";
import { BendToolchain, DiagnosticsMode } from "@bend2/toolchain";
import { ProofStatus, proofBody, proofGoal, proofStatus, unsafeAllowlist, unsafeReview } from "./proofModel.js";
import { detailsHtml } from "./proofDetailsHtml.js";
import { dependencyAccessibilityLabel, fileAccessibilityLabel, lawAccessibilityLabel, projectAccessibilityLabel } from "./accessibilityLabels.js";
import { selectProofContext } from "./proofContext.js";

type ProofNode = ProjectNode | FileNode | LawNode | DependencyNode;
let proofDetailsPanel: vscode.WebviewPanel | undefined;

class ProjectNode extends vscode.TreeItem {
  constructor(public readonly projectUri: vscode.Uri, public readonly projectName: string) {
    super(projectName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "bend2Project";
    this.iconPath = new vscode.ThemeIcon("folder-library");
    this.accessibilityInformation = { label: projectAccessibilityLabel(projectName) };
  }
}

class FileNode extends vscode.TreeItem {
  constructor(public readonly fileUri: vscode.Uri, label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "bend2File";
    this.resourceUri = fileUri;
    this.command = { command: "vscode.open", title: "Open File", arguments: [fileUri] };
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.accessibilityInformation = { label: fileAccessibilityLabel(label) };
  }
}

class LawNode extends vscode.TreeItem {
  constructor(public readonly fileUri: vscode.Uri, public readonly lawName: string, public readonly line: number, public readonly status: ProofStatus, public readonly dependencies: string[]) {
    super(lawName, dependencies.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = "bend2Law";
    this.description = status;
    this.tooltip = `${lawName}: ${status}`;
    if (dependencies.length > 0) this.tooltip = `${this.tooltip}\nDependencies: ${dependencies.join(", ")}`;
    this.iconPath = new vscode.ThemeIcon(
      status === "proved" ? "pass" :
      status === "open" ? "warning" :
      status === "failed" ? "error" :
      status === "unsafe" ? "shield" :
      status === "foreign" ? "plug" :
      status === "not checked" ? "question" : "circle-slash",
    );
    this.accessibilityInformation = { label: lawAccessibilityLabel(lawName, status, dependencies.length) };
    this.command = {
      command: "bend2.openLaw",
      title: "Open Law",
      arguments: [fileUri, line],
    };
  }
}

class DependencyNode extends vscode.TreeItem {
  constructor(public readonly dependency: string) {
    super(dependency, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "bend2ProofDependency";
    this.description = "proof dependency";
    this.iconPath = new vscode.ThemeIcon("symbol-reference");
    this.accessibilityInformation = { label: dependencyAccessibilityLabel(dependency) };
  }
}

export class ProofExplorer implements vscode.TreeDataProvider<ProofNode> {
  private readonly changes = new vscode.EventEmitter<ProofNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changes.event;

  constructor(context: vscode.ExtensionContext) {
    for (const pattern of ["**/LAWS.bend", "**/PROOF.bend", "**/UNSAFE_OK"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
      context.subscriptions.push(
        watcher,
        watcher.onDidCreate(() => this.refresh()),
        watcher.onDidChange(() => this.refresh()),
        watcher.onDidDelete(() => this.refresh()),
      );
    }
  }

  refresh(): void {
    this.changes.fire();
  }

  getTreeItem(element: ProofNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProofNode): Promise<ProofNode[]> {
    if (!vscode.workspace.workspaceFolders) return [];
    if (!element) {
      const lawFiles = await vscode.workspace.findFiles("**/LAWS.bend", "**/node_modules/**");
      return lawFiles.map((file) => new ProjectNode(file, this.projectName(file)));
    }
    if (element instanceof ProjectNode) {
      const projectFolder = vscode.Uri.file(path.dirname(element.projectUri.fsPath));
      const proofFile = vscode.Uri.joinPath(projectFolder, "PROOF.bend");
      const unsafeFile = vscode.Uri.joinPath(projectFolder, "UNSAFE_OK");
      const children: ProofNode[] = [new FileNode(element.projectUri, "LAWS.bend")];
      let proofContent = "";
      let unsafeDocumented = false;
      let unsafeEntries = new Set<string>();
      let compilerStatus: "passed" | "failed" | undefined;
      let compilerAvailable = false;
      try {
        await vscode.workspace.fs.stat(proofFile);
        proofContent = Buffer.from(await vscode.workspace.fs.readFile(proofFile)).toString("utf8");
        children.push(new FileNode(proofFile, "PROOF.bend"));
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) {
          const settings = vscode.workspace.getConfiguration("bend2");
          const adapter = new BendToolchain({
            workspaceRoot: root,
            executablePath: settings.get<string>("executablePath", "bend"),
            executableArgs: settings.get<string[]>("executableArgs", []),
            diagnosticsMode: settings.get<DiagnosticsMode>("diagnosticsMode", "auto"),
          });
          const compiler = await adapter.discover();
          if (compiler.available) {
            compilerAvailable = true;
            const result = await adapter.check(proofFile.fsPath);
            if (result.code === 0) compilerStatus = "passed";
            else if (result.code !== null) compilerStatus = "failed";
          }
        }
      } catch {
        // A law file without a proof file is useful information in the explorer.
      }
      try {
        const unsafeSource = Buffer.from(await vscode.workspace.fs.readFile(unsafeFile)).toString("utf8");
        unsafeEntries = unsafeAllowlist(unsafeSource);
        unsafeDocumented = true;
      } catch {
        // UNSAFE_OK is optional and should not make an otherwise valid project disappear.
      }
      const content = Buffer.from(await vscode.workspace.fs.readFile(element.projectUri)).toString("utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, lineNumber) => {
        const match = /^\s*law\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        if (match) {
          const status = proofStatus(proofContent, match[1], compilerStatus, compilerAvailable);
          const dependencies = proofDependencies(proofContent, match[1]);
          const law = new LawNode(element.projectUri, match[1], lineNumber, status, dependencies);
          if (status === "unsafe" || status === "foreign") {
            if (unsafeDocumented) {
              const review = unsafeReview(dependencies, unsafeEntries);
              const reviewed = review.reviewed.length > 0 ? `registered: ${review.reviewed.join(", ")}` : "no inferred dependency is registered";
              const unlisted = review.unlisted.length > 0 ? `unlisted: ${review.unlisted.join(", ")}` : "all inferred dependencies are registered";
              law.tooltip = `${law.tooltip}\nUNSAFE_OK review — ${reviewed}; ${unlisted}.`;
            } else {
              law.tooltip = `${law.tooltip}\nNo UNSAFE_OK record was found for this ${status} proof.`;
            }
          }
          children.push(law);
        }
      });
      if (unsafeDocumented) {
        children.push(new FileNode(unsafeFile, "UNSAFE_OK (reviewed)"));
      }
      return children;
    }
    if (element instanceof LawNode) return element.dependencies.map((dependency) => new DependencyNode(dependency));
    return [];
  }

  private projectName(file: vscode.Uri): string {
    const folder = file.path.substring(0, file.path.lastIndexOf("/"));
    return folder.substring(folder.lastIndexOf("/") + 1) || "Bend 2 project";
  }
}

function proofDependencies(source: string, lawName: string): string[] {
  const body = proofBody(source, lawName);
  if (!body) return [];
  const ignored = new Set(["if", "for", "match", "case", "def", "law", "type", "return"]);
  const dependencies = new Set<string>();
  for (const match of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/g)) {
    const name = match[1];
    if (name !== lawName && !ignored.has(name)) dependencies.add(name);
  }
  return [...dependencies].sort((left, right) => left.localeCompare(right));
}

export function openLaw(uri: vscode.Uri, line: number): Thenable<void> {
  return vscode.workspace.openTextDocument(uri).then((document) => vscode.window.showTextDocument(document).then((editor) => {
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }));
}

function lawStatement(source: string, lawName: string): string {
  const escaped = lawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^\\s*law\\s+${escaped}.*$`, "m"));
  return match?.[0]?.trim() ?? `law ${lawName}`;
}

function proofContext(source: string, lawName: string): string {
  const body = proofBody(source, lawName);
  if (!body) return "";
  const lines = body.split(/\r?\n/);
  return lines.slice(0, Math.min(lines.length, 4)).join("\n").trim();
}

export async function showProofDetails(uri: vscode.Uri | string, lawName: string): Promise<void> {
  const lawUri = typeof uri === "string" ? vscode.Uri.parse(uri) : uri;
  const lawSource = Buffer.from(await vscode.workspace.fs.readFile(lawUri)).toString("utf8");
  const proofFile = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(lawUri.fsPath)), "PROOF.bend");
  let proofSource = "";
  try {
    proofSource = Buffer.from(await vscode.workspace.fs.readFile(proofFile)).toString("utf8");
  } catch {
    // Missing proof is an expected state shown in the details panel.
  }
  let compilerStatus: "passed" | "failed" | undefined;
  let compilerAvailable = false;
  let compilerContext: string[] | undefined;
  const notes: string[] = [];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root && proofSource) {
    const settings = vscode.workspace.getConfiguration("bend2");
    const adapter = new BendToolchain({
      workspaceRoot: root,
      executablePath: settings.get<string>("executablePath", "bend"),
      executableArgs: settings.get<string[]>("executableArgs", []),
      diagnosticsMode: settings.get<DiagnosticsMode>("diagnosticsMode", "auto"),
    });
    const compiler = await adapter.discover();
    if (compiler.available) {
      compilerAvailable = true;
      const result = await adapter.check(proofFile.fsPath);
      if (result.code === 0) compilerStatus = "passed";
      else if (result.code !== null) compilerStatus = "failed";
      for (const diagnostic of result.diagnostics) {
        if (!compilerContext && diagnostic.proofContext && diagnostic.proofContext.length > 0) compilerContext = diagnostic.proofContext;
        const location = `${diagnostic.file}:${diagnostic.line + 1}:${diagnostic.column + 1}`;
        const typeDetails = [diagnostic.expectedType && `Expected: ${diagnostic.expectedType}`, diagnostic.observedType && `Observed: ${diagnostic.observedType}`].filter(Boolean);
        const proofDetails = [
          diagnostic.category && `Category: ${diagnostic.category}`,
          diagnostic.proofContext && `Context: ${diagnostic.proofContext.join("; ")}`,
          diagnostic.proofDependencies && `Dependencies: ${diagnostic.proofDependencies.join(", ")}`,
        ].filter(Boolean);
        const details = [...typeDetails, ...proofDetails];
        notes.push(`${location} ${diagnostic.severity}: ${diagnostic.message}${details.length > 0 ? ` (${details.join(", ")})` : ""}`);
      }
    } else if (compiler.error) {
      notes.push(`Compiler unavailable: ${compiler.error}`);
    }
  }
  const status = proofStatus(proofSource, lawName, compilerStatus, compilerAvailable);
  const panel = proofDetailsPanel ?? vscode.window.createWebviewPanel("bend2.proofDetails", "Bend 2 Proof Details", vscode.ViewColumn.Beside, { enableScripts: false, retainContextWhenHidden: true });
  proofDetailsPanel = panel;
  panel.title = `Proof: ${lawName}`;
  panel.webview.html = detailsHtml(String(Date.now()), {
    lawName,
    status,
    statement: lawStatement(lawSource, lawName),
    context: selectProofContext(proofContext(proofSource, lawName), compilerContext),
    proof: proofBody(proofSource, lawName) ?? "",
    dependencies: proofDependencies(proofSource, lawName),
    notes,
  });
  panel.onDidDispose(() => {
    if (proofDetailsPanel === panel) proofDetailsPanel = undefined;
  }, undefined, []);
}

export async function showProofGoal(uri: vscode.Uri | string, lawName: string): Promise<void> {
  const lawUri = typeof uri === "string" ? vscode.Uri.parse(uri) : uri;
  const proofFile = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(lawUri.fsPath)), "PROOF.bend");
  let proofSource = "";
  try {
    proofSource = Buffer.from(await vscode.workspace.fs.readFile(proofFile)).toString("utf8");
  } catch {
    vscode.window.showInformationMessage(`No proof definition for '${lawName}' was found.`);
    return;
  }
  const body = proofBody(proofSource, lawName);
  if (!body) {
    vscode.window.showInformationMessage(`No proof definition for '${lawName}' was found.`);
    return;
  }
  const bodyStart = proofSource.indexOf(body);
  const localGoal = proofGoal(proofSource, lawName);
  const output = vscode.window.createOutputChannel("Bend 2 Proof Goal");
  output.show(true);
  let compilerGoal: string | undefined;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const settings = vscode.workspace.getConfiguration("bend2");
    const adapter = new BendToolchain({
      workspaceRoot: root,
      executablePath: settings.get<string>("executablePath", "bend"),
      executableArgs: settings.get<string[]>("executableArgs", []),
      diagnosticsMode: settings.get<DiagnosticsMode>("diagnosticsMode", "auto"),
    });
    const compiler = await adapter.discover();
    if (compiler.available) {
      const result = await adapter.check(proofFile.fsPath);
      const goal = result.diagnostics.find((diagnostic) => diagnostic.category === "proof-goal" || /open goal|proof goal|hole/i.test(diagnostic.message));
      if (goal) {
        compilerGoal = `${goal.message}${goal.proofContext?.length ? `\nContext: ${goal.proofContext.join("; ")}` : ""}${goal.proofDependencies?.length ? `\nDependencies: ${goal.proofDependencies.join(", ")}` : ""}`;
      }
    } else if (compiler.error) output.appendLine(`Compiler unavailable: ${compiler.error}`);
  }
  if (compilerGoal) output.appendLine(`Compiler goal for ${lawName}:\n${compilerGoal}`);
  else if (localGoal) output.appendLine(`Open proof goal for ${lawName}: ${localGoal.token}`);
  else output.appendLine(`No explicit proof hole was found for ${lawName}. The compiler may expose the current goal after checking.`);
  if (localGoal && bodyStart >= 0) {
    const line = localGoal.line;
    const document = await vscode.workspace.openTextDocument(proofFile);
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(line, localGoal.character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}
