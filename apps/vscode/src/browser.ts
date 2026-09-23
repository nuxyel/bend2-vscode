import * as vscode from "vscode";
import { BrowserDiagnostic, parseBrowserDiagnostics } from "./browserParser.js";
import { BrowserWorkerFile, BrowserWorkerLocation, BrowserWorkerSymbolInformation } from "./browserWorkerCore.js";

const processCommands = [
  "bend2.checkFile",
  "bend2.checkWorkspace",
  "bend2.runProjectGate",
  "bend2.runSabotage",
  "bend2.buildFile",
  "bend2.runFile",
  "bend2.compareBackends",
  "bend2.benchmarkFile",
  "bend2.showBase",
  "bend2.showVersion",
  "bend2.restartLanguageServer",
  "bend2.openProof",
  "bend2.showProofDetails",
  "bend2.showProofGoal",
  "bend2.checkProof",
  "bend2.reviewLawChanges",
];

const completionKeywords = ["def", "law", "type", "is", "match", "case", "let", "do", "for", "where", "import", "True", "False", "Nat", "U32", "F32", "IO"];
const browserSemanticTokenTypes = ["keyword", "function", "type", "law", "comment"];
const browserSemanticLegend = new vscode.SemanticTokensLegend(browserSemanticTokenTypes);
type BrowserDocumentSymbol = vscode.DocumentSymbol & { bendDeclaration?: string };

export function activate(context: vscode.ExtensionContext): void {
  const index = new BrowserWorkspaceIndex(context.extensionUri);
  const diagnostics = vscode.languages.createDiagnosticCollection("bend2-web");
  context.subscriptions.push(diagnostics);
  const publishDiagnostics = (document: vscode.TextDocument): void => {
    if (document.languageId !== "bend") return;
    diagnostics.set(document.uri, browserDiagnostics(document));
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(publishDiagnostics),
    vscode.workspace.onDidChangeTextDocument((event) => publishDiagnostics(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
  );
  for (const document of vscode.workspace.textDocuments) publishDiagnostics(document);
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider("bend", {
    provideDocumentSymbols(document) {
      return browserSymbols(document);
    },
  }));
  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider("bend", {
    provideFoldingRanges(document) {
      const declarations = browserSymbols(document).filter((symbol) => symbol.kind !== vscode.SymbolKind.Constructor);
      return declarations.slice(0, -1).map((symbol, index) => {
        const next = declarations[index + 1];
        const startLine = symbol.range.start.line;
        const endLine = (next?.range.start.line ?? document.lineCount) - 1;
        return new vscode.FoldingRange(startLine, endLine, vscode.FoldingRangeKind.Region);
      }).filter((range) => range.end > range.start);
    },
  }));
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider("bend", {
    provideDocumentSemanticTokens(document) {
      const builder = new vscode.SemanticTokensBuilder(browserSemanticLegend);
      for (let line = 0; line < document.lineCount; line += 1) {
        const text = document.lineAt(line).text;
        const code = codeLine(text);
        const declaration = /\b(def|law|type)\s+((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)/.exec(code);
        if (declaration) {
          const keywordIndex = declaration.index;
          const nameIndex = keywordIndex + declaration[0].lastIndexOf(declaration[2]);
          builder.push(line, keywordIndex, declaration[1].length, declaration[1] === "def" ? 0 : declaration[1] === "law" ? 3 : 2);
          builder.push(line, nameIndex, declaration[2].length, declaration[1] === "def" ? 1 : declaration[1] === "law" ? 3 : 2);
        }
        const comment = text.indexOf("#");
        if (comment >= 0) builder.push(line, comment, text.length - comment, 4);
      }
      return builder.build();
    },
  }, browserSemanticLegend));
  context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query) {
      return index.workspaceSymbols(query);
    },
  }));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider("bend", {
    async provideDefinition(document, position) {
      const word = wordAt(document, position);
      if (!word) return undefined;
      const localDeclaration = declarationAt(document, word);
      if (localDeclaration) return new vscode.Location(document.uri, localDeclaration.selectionRange);
      return index.findDefinition(document, word);
    },
  }));
  context.subscriptions.push(vscode.languages.registerTypeDefinitionProvider("bend", {
    async provideTypeDefinition(document, position) {
      const name = wordAt(document, position);
      if (!name) return undefined;
      const local = typeDeclarationAt(document, name);
      if (local) return new vscode.Location(document.uri, local);
      return index.findTypeDefinition(name);
    },
  }));
  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider("bend", {
    provideDocumentLinks(document) {
      const links: vscode.DocumentLink[] = [];
      for (let line = 0; line < document.lineCount; line += 1) {
        const text = document.lineAt(line).text;
        const match = /^\s*import\s+([^\s]+)/.exec(text);
        if (!match || !match[1].startsWith(".")) continue;
        const start = text.indexOf(match[1], match.index ?? 0);
        const target = browserImportUri(document.uri, match[1]);
        if (!target) continue;
        const link = new vscode.DocumentLink(new vscode.Range(line, start, line, start + match[1].length), target);
        link.tooltip = `Open ${match[1]}`;
        links.push(link);
      }
      return links;
    },
  }));
  context.subscriptions.push(vscode.languages.registerReferenceProvider("bend", {
    async provideReferences(document, position) {
      const name = wordAt(document, position);
      return name ? index.findReferences(name, document) : [];
    },
  }));
  context.subscriptions.push(vscode.languages.registerRenameProvider("bend", {
    async provideRenameEdits(document, position, newName) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return undefined;
      const name = wordAt(document, position);
      if (!name) return undefined;
      const edit = new vscode.WorkspaceEdit();
      for (const location of await index.findReferences(name, document)) edit.replace(location.uri, location.range, newName);
      return edit;
    },
  }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider("bend", {
    async provideCompletionItems(document) {
      const items = new Map<string, vscode.CompletionItem>();
      for (const keyword of completionKeywords) {
        const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
        item.detail = "Bend 2 keyword";
        items.set(keyword, item);
      }
      for (const symbol of browserSymbols(document)) {
        const item = new vscode.CompletionItem(symbol.name, symbol.kind === vscode.SymbolKind.Constructor ? vscode.CompletionItemKind.Constructor : vscode.CompletionItemKind.Function);
        item.detail = `Bend 2 ${symbol.detail}`;
        items.set(symbol.name, item);
      }
      for (const symbol of await index.workspaceSymbols("")) {
        if (items.has(symbol.name)) continue;
        const item = new vscode.CompletionItem(symbol.name, vscode.CompletionItemKind.Reference);
        item.detail = "Bend 2 workspace symbol";
        items.set(symbol.name, item);
      }
      return [...items.values()];
    },
  }, ".", ":"));
  context.subscriptions.push(vscode.languages.registerHoverProvider("bend", {
    async provideHover(document, position) {
      const name = wordAt(document, position);
      if (!name) return undefined;
      const local = browserSymbols(document).find((symbol) => symbol.name === name || symbol.name.split(".").pop() === name);
      const symbol = local ?? await index.findSymbol(name);
      if (!symbol) return undefined;
      const contents = new vscode.MarkdownString();
      const declaration = local ? document.lineAt(local.range.start.line).text.trim() : (symbol as BrowserDocumentSymbol).bendDeclaration ?? `${symbol.detail} ${symbol.name}`;
      contents.appendCodeblock(declaration, "bend");
      return new vscode.Hover(contents, symbol.selectionRange);
    },
  }));
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider("bend", {
    async provideDocumentFormattingEdits(document, options, token) {
      if (token.isCancellationRequested) return [];
      try {
        const { formatBend } = await import("@bend2/language-server/dist/officialFormatter.js");
        const formatted = formatBend(document.getText(), options);
        if (formatted === document.getText()) return [];
        return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), formatted)];
      } catch {
        return [];
      }
    },
  }));
  for (const command of processCommands) {
    context.subscriptions.push(vscode.commands.registerCommand(command, () => {
      void vscode.window.showWarningMessage(`${command} requires a desktop or remote VS Code host with Bend 2 process access.`);
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand("bend2.copySupportDiagnostics", async () => {
    await vscode.env.clipboard.writeText(JSON.stringify({ schemaVersion: 1, vscode: vscode.version, web: true }, null, 2));
    void vscode.window.showInformationMessage("Bend 2 web support diagnostics copied without source code.");
  }));
  context.subscriptions.push(vscode.commands.registerCommand("bend2.refreshProofExplorer", () => {
    void vscode.window.showInformationMessage("Proof Explorer requires a desktop or remote VS Code host.");
  }));
  context.subscriptions.push({ dispose: () => index.dispose() });
}

export function deactivate(): void {}

function browserSymbols(document: vscode.TextDocument): BrowserDocumentSymbol[] {
  const symbols: BrowserDocumentSymbol[] = [];
  let activeType: string | undefined;
  for (let line = 0; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    if (activeType && text.trim() && !/^\s/.test(text)) activeType = undefined;
    const match = /^\s*(?:(?:public|private)\s+)?(def|law|type)\s+((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)/.exec(text);
    if (match) {
      const name = match[2];
      const start = text.indexOf(name, match.index ?? 0);
      const range = new vscode.Range(line, 0, line, text.length);
      const selectionRange = new vscode.Range(line, start, line, start + name.length);
      const kind = match[1] === "type" ? vscode.SymbolKind.Struct : match[1] === "law" ? vscode.SymbolKind.Event : vscode.SymbolKind.Function;
      const symbol = new vscode.DocumentSymbol(name, match[1], kind, range, selectionRange) as BrowserDocumentSymbol;
      symbol.bendDeclaration = text.trim();
      symbols.push(symbol);
      activeType = match[1] === "type" ? name : undefined;
      continue;
    }
    if (activeType) {
      const constructor = /^\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{/.exec(text);
      if (constructor) {
        const localName = constructor[1];
        const name = `${activeType}.${localName}`;
        const start = text.indexOf(localName, constructor.index ?? 0);
        const range = new vscode.Range(line, 0, line, text.length);
        const selectionRange = new vscode.Range(line, start, line, start + localName.length);
        const symbol = new vscode.DocumentSymbol(name, `constructor ${name}`, vscode.SymbolKind.Constructor, range, selectionRange) as BrowserDocumentSymbol;
        symbol.bendDeclaration = text.trim();
        symbols.push(symbol);
      }
    }
  }
  return symbols;
}

function browserDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  return parseBrowserDiagnostics(document.getText()).map((item: BrowserDiagnostic) => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(item.line, item.start, item.line, item.end),
      item.message,
      item.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = "Bend 2 web parser";
    diagnostic.relatedInformation = item.relatedInformation?.map((related) => new vscode.DiagnosticRelatedInformation(
      new vscode.Location(document.uri, new vscode.Range(related.line, related.start, related.line, related.end)),
      related.message,
    ));
    return diagnostic;
  });
}

function wordAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const text = document.lineAt(position.line).text;
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    const start = match.index ?? 0;
    if (position.character >= start && position.character <= start + match[0].length) return match[0];
  }
  return undefined;
}

function declarationAt(document: vscode.TextDocument, name: string): { selectionRange: vscode.Range } | undefined {
  for (let line = 0; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    const match = new RegExp(`^\\s*(?:(?:public|private)\\s+)?(?:def|law|type)\\s+${escapeRegExp(name)}(?=\\s|\\(|:)`).exec(text);
    if (!match) continue;
    const start = text.indexOf(name, match.index ?? 0);
    return { selectionRange: new vscode.Range(line, start, line, start + name.length) };
  }
  const constructor = browserSymbols(document).find((symbol) => symbol.kind === vscode.SymbolKind.Constructor && symbol.name.split(".").pop() === name);
  if (constructor) return { selectionRange: constructor.selectionRange };
  return undefined;
}

function typeDeclarationAt(document: vscode.TextDocument, name: string): vscode.Range | undefined {
  const matchName = escapeRegExp(name);
  for (let line = 0; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    const match = new RegExp(`^\\s*(?:(?:public|private)\\s+)?type\\s+${matchName}(?=\\s|\\(|:)`).exec(text);
    if (!match) continue;
    const start = text.indexOf(name, match.index ?? 0);
    return new vscode.Range(line, start, line, start + name.length);
  }
  return undefined;
}

function browserImportUri(documentUri: vscode.Uri, importPath: string): vscode.Uri | undefined {
  if (!importPath.startsWith(".")) return undefined;
  const slash = documentUri.path.lastIndexOf("/");
  const directory = documentUri.with({ path: slash >= 0 ? documentUri.path.slice(0, slash + 1) : "/" });
  return vscode.Uri.joinPath(directory, importPath);
}

class BrowserWorkspaceIndex {
  private readonly entries = new Map<string, { version: number; text: string; document: vscode.TextDocument; symbols: BrowserDocumentSymbol[] }>();
  private worker?: Worker;
  private requestId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(extensionUri: vscode.Uri) {
    if (typeof Worker === "undefined") return;
    try {
      this.worker = new Worker(vscode.Uri.joinPath(extensionUri, "dist", "browserWorker.js").toString(true));
      this.worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; value: unknown }>) => {
        const request = this.pending.get(event.data.id);
        if (!request) return;
        this.pending.delete(event.data.id);
        if (event.data.ok) request.resolve(event.data.value);
        else request.reject(new Error(String(event.data.value)));
      };
      this.worker.onerror = () => this.disableWorker(new Error("The Bend 2 browser worker failed."));
    } catch {
      // Browser hosts without worker URL support use the same parser locally.
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.disableWorker(new Error("The Bend 2 browser index was disposed."));
  }

  async findDefinition(document: vscode.TextDocument, qualifiedName: string): Promise<vscode.Location | undefined> {
    const name = qualifiedName.split(".").pop() ?? qualifiedName;
    const entries = await this.entriesForWorkspace();
    if (this.worker) {
      const result = await this.request<BrowserWorkerLocation | null>({ method: "definition", currentUri: document.uri.toString(), name }).catch(() => undefined);
      return result ? new vscode.Location(vscode.Uri.parse(result.uri), workerRange(result.range)) : undefined;
    }
    for (const entry of entries) {
      if (entry.document.uri.toString() === document.uri.toString()) continue;
      const symbol = entry.symbols.find((candidate) => candidate.name === qualifiedName || candidate.name.split(".").pop() === name);
      if (symbol) return new vscode.Location(entry.document.uri, symbol.selectionRange);
    }
    return undefined;
  }

  async findSymbol(qualifiedName: string): Promise<BrowserDocumentSymbol | undefined> {
    const name = qualifiedName.split(".").pop() ?? qualifiedName;
    const entries = await this.entriesForWorkspace();
    for (const entry of entries) {
      const symbol = entry.symbols.find((candidate) => candidate.name === qualifiedName || candidate.name.split(".").pop() === name);
      if (symbol) return symbol;
    }
    return undefined;
  }

  async findTypeDefinition(qualifiedName: string): Promise<vscode.Location | undefined> {
    const name = qualifiedName.split(".").pop() ?? qualifiedName;
    const entries = await this.entriesForWorkspace();
    for (const entry of entries) {
      const symbol = entry.symbols.find((candidate) => candidate.detail === "type" && (candidate.name === qualifiedName || candidate.name.split(".").pop() === name));
      if (symbol) return new vscode.Location(entry.document.uri, symbol.selectionRange);
    }
    return undefined;
  }

  async findReferences(qualifiedName: string, currentDocument?: vscode.TextDocument): Promise<vscode.Location[]> {
    const name = qualifiedName.split(".").pop() ?? qualifiedName;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return [];
    const entries = await this.entriesForWorkspace(currentDocument);
    const expression = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    const locations: vscode.Location[] = [];
    for (const entry of entries) {
      for (let line = 0; line < entry.document.lineCount; line += 1) {
        const text = entry.document.lineAt(line).text;
        const code = codeLine(text);
        for (const match of code.matchAll(expression)) {
          const start = match.index ?? 0;
          locations.push(new vscode.Location(entry.document.uri, new vscode.Range(line, start, line, start + name.length)));
        }
      }
    }
    return locations;
  }

  async workspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    const results: vscode.SymbolInformation[] = [];
    const normalizedQuery = query.trim().toLowerCase();
    const entries = await this.entriesForWorkspace();
    if (this.worker) {
      const workerResults = await this.request<BrowserWorkerSymbolInformation[]>({ method: "symbols", query }).catch(() => undefined);
      if (workerResults) return workerResults.map((symbol) => new vscode.SymbolInformation(symbol.name, symbol.kind, workerRange(symbol.range), vscode.Uri.parse(symbol.uri)));
    }
    for (const entry of entries) {
      for (const symbol of entry.symbols) {
        if (normalizedQuery && !symbol.name.toLowerCase().includes(normalizedQuery)) continue;
        results.push(new vscode.SymbolInformation(symbol.name, symbol.kind, symbol.range, entry.document.uri));
      }
    }
    return results;
  }

  private async entriesForWorkspace(extraDocument?: vscode.TextDocument): Promise<Array<{ version: number; text: string; document: vscode.TextDocument; symbols: BrowserDocumentSymbol[] }>> {
    const files = await vscode.workspace.findFiles("**/*.bend", "**/node_modules/**", 500);
    const knownFiles = new Map(files.map((file) => [file.toString(), file]));
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId !== "bend" || !vscode.workspace.getWorkspaceFolder(document.uri)) continue;
      knownFiles.set(document.uri.toString(), document.uri);
    }
    if (extraDocument?.languageId === "bend") knownFiles.set(extraDocument.uri.toString(), extraDocument.uri);
    const workspaceFiles = [...knownFiles.values()];
    const active = new Set(workspaceFiles.map((file) => file.toString()));
    for (const uri of this.entries.keys()) {
      if (!active.has(uri)) this.entries.delete(uri);
    }
    const entries: Array<{ version: number; text: string; document: vscode.TextDocument; symbols: BrowserDocumentSymbol[] }> = [];
    for (const file of workspaceFiles) {
      try {
        const document = await vscode.workspace.openTextDocument(file);
        const key = document.uri.toString();
        const text = document.getText();
        const cached = this.entries.get(key);
        const entry = cached?.version === document.version && cached.text === text
          ? cached
          : { version: document.version, text, document, symbols: browserSymbols(document) };
        this.entries.set(key, entry);
        entries.push(entry);
      } catch {
        // Keep search responsive when a remote browser workspace has an unreadable file.
      }
    }
    if (this.worker) {
      await this.request<null>({ method: "index", files: entries.map((entry): BrowserWorkerFile => ({ uri: entry.document.uri.toString(), text: entry.text })) }).catch(() => undefined);
    }
    return entries;
  }

  private request<T>(request: { method: "index"; files: BrowserWorkerFile[] } | { method: "definition"; currentUri: string; name: string } | { method: "symbols"; query: string }): Promise<T> {
    if (!this.worker) return Promise.reject(new Error("Browser worker is unavailable."));
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker?.postMessage({ ...request, id });
    });
  }

  private disableWorker(error: Error): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

function workerRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeLine(text: string): string {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return text.slice(0, index);
  }
  return text;
}
