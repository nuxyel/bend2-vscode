import {
  CompletionItem,
  CompletionItemKind,
  CodeLens,
  CallHierarchyIncomingCall,
  CallHierarchyIncomingCallsParams,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyOutgoingCallsParams,
  CallHierarchyPrepareParams,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  FoldingRangeKind,
  Hover,
  InitializeParams,
  Location,
  ProposedFeatures,
  SemanticTokensParams,
  SemanticTokensRangeParams,
  SymbolKind,
  SymbolInformation,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  TextDocuments,
  TextDocumentSyncKind,
  TextDocumentPositionParams,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbolParams,
  DidChangeConfigurationParams,
  DidChangeWatchedFilesParams,
  FileChangeType,
  MessageType,
  ShowMessageNotification,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { BendSymbol, codeOnly, identifierAt, parseBend } from "./parser.js";
import { formatBend } from "./officialFormatter.js";
import { BendToolchain, DiagnosticsMode } from "@bend2/toolchain";
import { BendWorkspaceIndex } from "./semanticIndex.js";
import { platformMismatchMessage } from "./environment.js";
import { semanticTokens, tokenModifiers, tokenTypes } from "./semanticTokens.js";
import { CheckScheduler } from "./checkScheduler.js";
import { callContextAt, parseBendSignature } from "./signatureHelp.js";
import { resolveValidationMode, ValidationMode } from "./validationMode.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const parsed = new Map<string, ReturnType<typeof parseBend>>();
let workspaceRoot = "";
let validationMode: ValidationMode = "onSave";
let validationModeExplicit = false;
let legacyValidationEnabled = true;
let configuredValidationMode: ValidationMode | undefined;
let formattingEnabled = true;
let executablePath = "bend";
let executableArgs: string[] = [];
let diagnosticsMode: DiagnosticsMode = "auto";
let autoImportEnabled = false;
let toolchain: BendToolchain | undefined;
let index: BendWorkspaceIndex | undefined;
let baseSymbols = new Map<string, string>();
let baseLoaded = false;
let baseLoading: Promise<void> | undefined;
let clientPlatform: string | undefined;
let clientRemoteName: string | null | undefined;
let clientUiKind: string | undefined;


function symbolKind(kind: BendSymbol["kind"]): SymbolKind {
  if (kind === "function") return SymbolKind.Function;
  if (kind === "law") return SymbolKind.Event;
  if (kind === "constructor") return SymbolKind.Constructor;
  if (kind === "type" || kind === "data") return SymbolKind.Struct;
  return SymbolKind.Namespace;
}

function callItem(symbol: BendSymbol & { uri: string }): CallHierarchyItem {
  return {
    name: symbol.name,
    kind: symbolKind(symbol.kind),
    detail: symbol.detail,
    uri: symbol.uri,
    range: symbol.range,
    selectionRange: symbol.selectionRange,
  };
}

function symbolHover(target: { symbol: BendSymbol & { uri: string }; uri: string }, activeDocument?: TextDocument): Hover {
  const indexed = index?.get(target.uri);
  const source = target.uri === activeDocument?.uri ? activeDocument.getText() : indexed?.source;
  const declaration = source?.split(/\r?\n/)[target.symbol.range.start.line]?.trim();
  return {
    contents: [{
      language: "bend",
      value: declaration || target.symbol.detail,
    }],
  };
}

function publishDiagnostics(uri: string): void {
  const document = documents.get(uri);
  if (!document) return;
  const result = parseBend(document.getText(), uri);
  parsed.set(uri, result);
  index?.update(uri, document.getText());
  const diagnostics: Diagnostic[] = validationMode !== "off"
    ? result.diagnostics.map((item) => ({
        message: item.message,
        source: item.source,
        severity: item.severity === "error" ? DiagnosticSeverity.Error : item.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
        range: item.range,
      }))
    : [];
  connection.sendDiagnostics({ uri, diagnostics });
}

function compilerDiagnostic(uri: string, item: { message: string; severity: "error" | "warning" | "info"; line: number; column: number; endLine?: number; endColumn?: number; code?: string; category?: string; expectedType?: string; observedType?: string; relatedInformation?: Array<{ file: string; line: number; column: number; endLine?: number; endColumn?: number; message: string }> }): Diagnostic {
  const severity = item.severity === "error" ? DiagnosticSeverity.Error : item.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information;
  const typeDetails = [
    item.expectedType ? `Expected: ${item.expectedType}` : "",
    item.observedType ? `Observed: ${item.observedType}` : "",
  ].filter(Boolean);
  return {
    message: typeDetails.length > 0 ? `${item.message}\n${typeDetails.join("\n")}` : item.message,
    source: "Bend 2 compiler",
    code: item.code ?? item.category,
    severity,
    range: { start: { line: item.line, character: item.column }, end: { line: item.endLine ?? item.line, character: item.endColumn ?? item.column + 1 } },
    relatedInformation: item.relatedInformation?.map((related) => ({
      location: {
        uri: path.isAbsolute(related.file) ? pathToUri(related.file) : pathToUri(path.resolve(workspaceRoot, related.file)),
        range: { start: { line: related.line, character: related.column }, end: { line: related.endLine ?? related.line, character: related.endColumn ?? related.column + 1 } },
      },
      message: related.message,
    })),
  };
}

function pathToUri(file: string): string {
  return pathToFileURL(file).toString();
}

function refreshIndexCompilerVersion(currentToolchain: BendToolchain, currentIndex: BendWorkspaceIndex): void {
  void currentToolchain.discover().then((info) => {
    if (index === currentIndex) currentIndex.setCompilerVersion(info.version);
  }).catch(() => undefined);
}

async function publishCompilerDiagnostics(uri: string, signal: AbortSignal): Promise<void> {
  const document = documents.get(uri);
  if (!document || !toolchain || validationMode === "parser" || validationMode === "off") return;
  const file = fileURLToPath(uri);
  const result = await toolchain.check(file, signal);
  if (signal.aborted || !documents.get(uri) || (validationMode !== "onSave" && validationMode !== "onType")) return;
  const target = path.resolve(file);
  const diagnostics = result.diagnostics
    .filter((item) => path.resolve(workspaceRoot, item.file || file) === target)
    .map((item) => compilerDiagnostic(uri, item));
  const parserDiagnostics = (parsed.get(uri)?.diagnostics ?? []).map((item) => ({
    message: item.message,
    source: item.source,
    severity: item.severity === "error" ? DiagnosticSeverity.Error : item.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
    range: item.range,
  }));
  connection.sendDiagnostics({ uri, diagnostics: [...parserDiagnostics, ...diagnostics] });
}

const checkScheduler = new CheckScheduler((uri, signal) => publishCompilerDiagnostics(uri, signal));

function scheduleCompilerCheck(uri: string, immediate = false): void {
  checkScheduler.schedule(uri, immediate);
}

function currentParsed(uri: string) {
  if (!parsed.has(uri)) publishDiagnostics(uri);
  return parsed.get(uri) ?? { symbols: [], diagnostics: [], words: new Set<string>(), imports: [] };
}

function loadBaseSymbols(): void {
  if (baseLoaded || baseLoading || !toolchain) return;
  baseLoading = toolchain.base().then((result) => {
    if (result.code !== 0) return;
    const parsedBase = parseBend(result.stdout);
    baseSymbols = new Map(parsedBase.symbols.filter((symbol) => symbol.kind !== "import").map((symbol) => [symbol.name, symbol.detail]));
    baseLoaded = true;
  }).catch(() => undefined).finally(() => {
    baseLoading = undefined;
  });
}

function localSymbolName(name: string): string {
  return name.split(".").pop() ?? name;
}

function autoImportCompletion(uri: string, symbol: BendSymbol & { uri: string }): CompletionItem | undefined {
  if (!autoImportEnabled || symbol.uri === uri || !index) return undefined;
  const document = index.get(uri);
  if (!document || document.parsed.imports.some((item) => item.resolvedUri === symbol.uri)) return undefined;
  try {
    const sourcePath = fileURLToPath(uri);
    const targetPath = fileURLToPath(symbol.uri);
    let alias = path.basename(targetPath, path.extname(targetPath));
    if (alias.toLowerCase() === "main") alias = path.basename(path.dirname(targetPath));
    alias = `${alias.charAt(0).toUpperCase()}${alias.slice(1)}`.replace(/[^A-Za-z0-9_]/g, "_") || "Imported";
    const used = new Set([...document.parsed.words, ...document.parsed.imports.map((item) => item.alias)]);
    const originalAlias = alias;
    let suffix = 2;
    while (used.has(alias)) alias = `${originalAlias}${suffix++}`;
    let importPath = path.relative(path.dirname(sourcePath), targetPath).replace(/\\/g, "/");
    if (!importPath.startsWith(".")) importPath = `./${importPath}`;
    return {
      label: `${alias}.${localSymbolName(symbol.name)}`,
      insertText: `${alias}.${localSymbolName(symbol.name)}`,
      kind: symbol.kind === "type" ? CompletionItemKind.Struct : symbol.kind === "constructor" ? CompletionItemKind.Constructor : symbol.kind === "law" ? CompletionItemKind.Reference : CompletionItemKind.Function,
      detail: `Import from ${importPath}`,
      additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: `import ${importPath} as ${alias}\n` }],
    };
  } catch {
    return undefined;
  }
}

connection.onInitialize((params: InitializeParams) => {
  const initializationOptions = params.initializationOptions as { clientPlatform?: string; remoteName?: string | null; uiKind?: string } | undefined;
  clientPlatform = initializationOptions?.clientPlatform;
  clientRemoteName = initializationOptions?.remoteName;
  clientUiKind = initializationOptions?.uiKind;
  workspaceRoot = params.rootUri ? fileURLToPath(params.rootUri) : process.cwd();
  toolchain = new BendToolchain({ workspaceRoot, executablePath, executableArgs, diagnosticsMode });
  baseSymbols = new Map();
  baseLoaded = false;
  index = new BendWorkspaceIndex(workspaceRoot);
  index.initialize();
  refreshIndexCompilerVersion(toolchain, index);
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: true } },
      completionProvider: { triggerCharacters: [".", ":"] },
      signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
      hoverProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      documentLinkProvider: { resolveProvider: false },
      referencesProvider: true,
      renameProvider: true,
      codeLensProvider: { resolveProvider: false },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      callHierarchyProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: { legend: { tokenTypes, tokenModifiers }, range: true, full: true },
      documentFormattingProvider: true,
    },
    serverInfo: { name: "Bend 2 Language Server", version: "0.1.0" },
  };
});

connection.onInitialized(() => {
  const mismatch = platformMismatchMessage(clientPlatform, process.platform, clientRemoteName, clientUiKind);
  if (mismatch) connection.sendNotification(ShowMessageNotification.type, { type: MessageType.Warning, message: mismatch });
});

connection.onDidChangeConfiguration((params: DidChangeConfigurationParams) => {
  const settings = params.settings as { bend2?: { validation?: boolean; validationMode?: "parser" | "onSave" | "onType" | "off"; validationModeExplicit?: boolean; executablePath?: string; executableArgs?: string[]; diagnosticsMode?: DiagnosticsMode; autoImport?: boolean; formatterMode?: "bundled" | "disabled" } };
  const configuredMode = settings.bend2?.validationMode;
  configuredValidationMode = configuredMode;
  legacyValidationEnabled = settings.bend2?.validation !== false;
  validationModeExplicit = settings.bend2?.validationModeExplicit === true;
  validationMode = resolveValidationMode({ configuredMode, legacyValidation: legacyValidationEnabled, modeExplicit: validationModeExplicit });
  executablePath = settings.bend2?.executablePath ?? "bend";
  executableArgs = settings.bend2?.executableArgs ?? [];
  diagnosticsMode = settings.bend2?.diagnosticsMode ?? "auto";
  autoImportEnabled = settings.bend2?.autoImport === true;
  formattingEnabled = settings.bend2?.formatterMode !== "disabled";
  checkScheduler.cancelAll();
  toolchain = new BendToolchain({ workspaceRoot, executablePath, executableArgs, diagnosticsMode });
  baseSymbols = new Map();
  baseLoaded = false;
  index = new BendWorkspaceIndex(workspaceRoot);
  index.initialize();
  refreshIndexCompilerVersion(toolchain, index);
  for (const document of documents.all()) publishDiagnostics(document.uri);
});

connection.onRequest("bend2/validationModeExplicitness", (params: { explicit: boolean }) => {
  validationModeExplicit = params.explicit;
  validationMode = resolveValidationMode({ configuredMode: configuredValidationMode, legacyValidation: legacyValidationEnabled, modeExplicit: validationModeExplicit });
  for (const document of documents.all()) publishDiagnostics(document.uri);
});

connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
  if (!index) return;
  for (const change of params.changes) {
    if (change.type === FileChangeType.Deleted) index.remove(change.uri);
    else void index.reload(change.uri);
  }
});

documents.onDidOpen((event) => publishDiagnostics(event.document.uri));
documents.onDidChangeContent((event) => {
  publishDiagnostics(event.document.uri);
  if (validationMode === "onType") scheduleCompilerCheck(event.document.uri);
});
documents.onDidSave((event) => {
  publishDiagnostics(event.document.uri);
  if (validationMode === "onSave") scheduleCompilerCheck(event.document.uri, true);
});
documents.onDidClose((event) => {
  checkScheduler.cancel(event.document.uri);
  parsed.delete(event.document.uri);
  void index?.reload(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onShutdown(() => {
  checkScheduler.cancelAll();
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const result = currentParsed(params.textDocument.uri);
  const keywords = ["def", "law", "type", "is", "import", "match", "case", "let", "do", "for", "exs", "where", "IO", "Nat", "U32", "F32", "True", "False"];
  loadBaseSymbols();
  const names = [...new Set([...result.words, ...(await index?.completionNames() ?? []), ...baseSymbols.keys()])].filter((name) => name.length > 1);
  const items: CompletionItem[] = [...new Set([...keywords, ...names])].map((label) => ({
    label,
    kind: keywords.includes(label) ? CompletionItemKind.Keyword : CompletionItemKind.Variable,
    detail: result.words.has(label) ? "Bend 2 symbol" : "Bend 2 keyword",
  }));
  if (autoImportEnabled && index) {
    for (const symbol of await index.completionSymbols()) {
      const completion = autoImportCompletion(params.textDocument.uri, symbol);
      if (completion && !items.some((item) => item.label === completion.label)) items.push(completion);
    }
  }
  return items;
});

connection.onSignatureHelp(async (params): Promise<SignatureHelp | null> => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !index) return null;
  const source = document.getText();
  const offset = document.offsetAt(params.position);
  const context = callContextAt(source, offset);
  if (!context) return null;
  const callNameStart = source.slice(0, offset).lastIndexOf(context.name);
  const before = source.slice(0, callNameStart);
  const line = before.split(/\r?\n/).length - 1;
  const character = (before.split(/\r?\n/).at(-1) ?? "").length;
  let target;
  if (context.name.includes(".")) {
    const [alias, ...memberParts] = context.name.split(".");
    const memberName = memberParts.join(".");
    const imported = index.get(document.uri)?.parsed.imports.find((item) => item.alias === alias)?.resolvedUri;
    if (imported && !index.get(imported)) await index.reload(imported);
    const importedDocument = imported ? index.get(imported) : undefined;
    const importedSymbol = importedDocument?.parsed.symbols.find((symbol) => symbol.name === memberName || symbol.name.split(".").at(-1) === memberName);
    if (importedDocument && importedSymbol) target = { uri: importedDocument.uri, symbol: { ...importedSymbol, uri: importedDocument.uri, provenance: importedDocument.provenance } };
  }
  target ??= await index.definition(document.uri, { line, character });
  if (!target || !["function", "law"].includes(target.symbol.kind)) return null;
  const targetDocument = index.get(target.uri);
  if (!targetDocument) return null;
  const signature = parseBendSignature(targetDocument.source, target.symbol.name.split(".").at(-1) ?? target.symbol.name);
  if (!signature) return null;
  const parameters = signature.parameters.map((parameter) => ParameterInformation.create(parameter.label));
  const activeParameter = Math.min(context.activeParameter, Math.max(0, parameters.length - 1));
  return {
    signatures: [SignatureInformation.create(signature.label, undefined, ...parameters)],
    activeSignature: 0,
    activeParameter,
  };
});

connection.onHover(async (params: TextDocumentPositionParams): Promise<Hover | null> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const name = identifierAt(document.getText(), params.position);
  if (!name) return null;
  const target = await index?.definition(document.uri, params.position);
  if (!target) {
    const baseDetail = baseSymbols.get(name) ?? baseSymbols.get(name.split(".").pop() ?? name);
    return baseDetail ? { contents: [{ language: "bend", value: baseDetail }] } : null;
  }
  return symbolHover(target, document);
});

connection.onDefinition(async (params: TextDocumentPositionParams): Promise<Location[]> => {
  const target = await index?.definition(params.textDocument.uri, params.position);
  return target ? [Location.create(target.uri, target.symbol.selectionRange)] : [];
});

connection.onTypeDefinition(async (params: TextDocumentPositionParams): Promise<Location[]> => {
  const target = await index?.definition(params.textDocument.uri, params.position);
  if (!target || target.symbol.kind !== "type") return [];
  return [Location.create(target.uri, target.symbol.selectionRange)];
});

connection.onDocumentLinks((params): DocumentLink[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  return currentParsed(document.uri).imports.flatMap((item) => item.resolvedUri ? [{
    range: item.range,
    target: item.resolvedUri,
    tooltip: `Open ${item.path}`,
  }] : []);
});

connection.onReferences(async (params) => {
  const target = await index?.definition(params.textDocument.uri, params.position);
  if (!target || !index) return [];
  return (await index.references(target)).map((item) => Location.create(item.uri, item.range));
});

connection.onRenameRequest(async (params) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.newName) || !index) return null;
  const target = await index.definition(params.textDocument.uri, params.position);
  if (!target) return null;
  const changes: Record<string, TextEdit[]> = {};
  for (const item of await index.references(target)) {
    (changes[item.uri] ??= []).push({ range: item.range, newText: params.newName });
  }
  return { changes } satisfies WorkspaceEdit;
});

connection.onDocumentSymbol((params): DocumentSymbol[] => currentParsed(params.textDocument.uri).symbols.map((item) => ({
  name: item.name,
  detail: item.detail,
  kind: symbolKind(item.kind),
  range: item.range,
  selectionRange: item.selectionRange,
})));

connection.onWorkspaceSymbol(async (params: WorkspaceSymbolParams): Promise<SymbolInformation[]> => {
  if (!index) return [];
  const query = params.query.toLowerCase();
  return (await index.completionSymbols())
    .filter((symbol) => !query || symbol.name.toLowerCase().includes(query))
    .map((symbol) => SymbolInformation.create(symbol.name, symbolKind(symbol.kind), symbol.range, symbol.uri));
});

connection.languages.callHierarchy.onPrepare(async (params: CallHierarchyPrepareParams): Promise<CallHierarchyItem[] | null> => {
  const target = await index?.ready().then(() => index?.symbolAt(params.textDocument.uri, params.position));
  return target ? [callItem(target)] : null;
});

connection.languages.callHierarchy.onOutgoingCalls(async (params: CallHierarchyOutgoingCallsParams): Promise<CallHierarchyOutgoingCall[]> => {
  if (!index) return [];
  const caller = index.enclosingSymbol(params.item.uri, params.item.selectionRange.start.line);
  const document = index.get(params.item.uri);
  if (!caller || !document) return [];
  const declarations = document.parsed.symbols.filter((symbol) => symbol.kind !== "import" && symbol.range.start.line > caller.range.start.line).sort((left, right) => left.range.start.line - right.range.start.line);
  const endLine = declarations[0]?.range.start.line ?? document.source.split(/\r?\n/).length;
  const outgoing = new Map<string, CallHierarchyOutgoingCall>();
  const lines = document.source.split(/\r?\n/);
  for (let lineNumber = caller.range.start.line + 1; lineNumber < endLine; lineNumber += 1) {
    const code = codeOnly(lines[lineNumber] ?? "");
    const calls = /((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    for (const match of code.matchAll(calls)) {
      const name = match[1];
      if (["if", "for", "match", "case", "def", "law", "type"].includes(name)) continue;
      const start = match.index ?? 0;
      const target = await index.definition(params.item.uri, { line: lineNumber, character: start });
      if (!target || target.symbol.kind === "type") continue;
      const key = `${target.uri}:${target.symbol.selectionRange.start.line}:${target.symbol.selectionRange.start.character}`;
      const fromRange = { start: { line: lineNumber, character: start }, end: { line: lineNumber, character: start + name.length } };
      const existing = outgoing.get(key);
      if (existing) existing.fromRanges.push(fromRange);
      else outgoing.set(key, { to: callItem(target.symbol), fromRanges: [fromRange] });
    }
  }
  return [...outgoing.values()];
});

connection.languages.callHierarchy.onIncomingCalls(async (params: CallHierarchyIncomingCallsParams): Promise<CallHierarchyIncomingCall[]> => {
  if (!index) return [];
  const target = await index.definition(params.item.uri, params.item.selectionRange.start);
  if (!target) return [];
  const incoming = new Map<string, CallHierarchyIncomingCall>();
  for (const reference of await index.references(target)) {
    const caller = index.enclosingSymbol(reference.uri, reference.range.start.line);
    if (!caller || (caller.uri === target.uri && caller.name === target.symbol.name)) continue;
    const key = `${caller.uri}:${caller.selectionRange.start.line}:${caller.selectionRange.start.character}`;
    const existing = incoming.get(key);
    if (existing) existing.fromRanges.push(reference.range);
    else incoming.set(key, { from: callItem(caller), fromRanges: [reference.range] });
  }
  return [...incoming.values()];
});

connection.onCodeLens((params): CodeLens[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  return currentParsed(document.uri).symbols
    .filter((item) => item.kind === "law")
    .map((item) => ({
      range: item.selectionRange,
      command: {
        title: "Bend 2: Open proof",
        command: "bend2.openProof",
        arguments: [document.uri, item.name],
      },
    }))
    .flatMap((lens) => [
      lens,
      {
        range: lens.range,
        command: {
          title: "Bend 2: Show proof goal",
          command: "bend2.showProofGoal",
          arguments: lens.command.arguments,
        },
      },
      {
        range: lens.range,
        command: {
          title: "Bend 2: Show proof details",
          command: "bend2.showProofDetails",
          arguments: lens.command.arguments,
        },
      },
      {
        range: lens.range,
        command: {
          title: "Bend 2: Check proof",
          command: "bend2.checkProof",
          arguments: lens.command.arguments,
        },
      },
    ]);
});

connection.onFoldingRanges((params): FoldingRange[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const lines = document.getText().split(/\r?\n/);
  const starts = lines.map((line, index) => /^\s*(?:def|law|type)\s+/.test(line) ? index : -1).filter((line) => line >= 0);
  return starts.slice(0, -1).map((start, index) => ({ startLine: start, endLine: starts[index + 1] - 1, kind: FoldingRangeKind.Region }));
});

connection.languages.semanticTokens.on((params: SemanticTokensParams) => {
  const document = documents.get(params.textDocument.uri);
  return document ? semanticTokens(document) : { data: [] };
});

connection.languages.semanticTokens.onRange((params: SemanticTokensRangeParams) => {
  const document = documents.get(params.textDocument.uri);
  return document ? semanticTokens(document, params.range) : { data: [] };
});

connection.onDocumentFormatting((params): TextEdit[] => {
  if (!formattingEnabled) return [];
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const source = document.getText();
  const formatted = formatBend(source, params.options);
  return formatted === source ? [] : [TextEdit.replace({ start: { line: 0, character: 0 }, end: document.positionAt(source.length) }, formatted)];
});

documents.listen(connection);
connection.listen();

export { workspaceRoot };
