import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BendImport, BendSymbol, ParsedDocument, codeOnly, identifierAt, parseBend } from "./parser.js";

export interface IndexProvenance {
  source: "tolerant-parser";
  provisional: true;
  compilerVersion: string | null;
}

export interface IndexedSymbol extends BendSymbol {
  uri: string;
  provenance: IndexProvenance;
}

export interface IndexedDocument {
  uri: string;
  source: string;
  parsed: ParsedDocument;
  provenance: IndexProvenance;
}

export interface SymbolLocation {
  symbol: IndexedSymbol;
  uri: string;
}

const ignoredDirectories = new Set([".git", "node_modules", ".bend", "dist", "build", "target"]);
const workspaceLoadConcurrency = 32;

function localName(name: string): string {
  return name.split(".").pop() ?? name;
}

function filePath(uri: string): string {
  return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
}

function rangeForLine(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

async function bendFiles(root: string, result: string[] = []): Promise<string[]> {
  if (result.length >= 5000) return result;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) await bendFiles(fullPath, result);
    else if (entry.isFile() && entry.name.endsWith(".bend")) result.push(fullPath);
    if (result.length >= 5000) break;
  }
  return result;
}

export class BendWorkspaceIndex {
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly workspaceRoot: string;
  private readonly provenance: IndexProvenance;
  private readyPromise: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, options: { compilerVersion?: string | null } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.provenance = {
      source: "tolerant-parser",
      provisional: true,
      compilerVersion: options.compilerVersion ?? null,
    };
  }

  initialize(): void {
    this.readyPromise = this.loadWorkspace();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  setCompilerVersion(version: string | null): void {
    this.provenance.compilerVersion = version;
  }

  update(uri: string, source: string): IndexedDocument {
    const document = { uri, source, parsed: parseBend(source, uri), provenance: this.provenance };
    this.documents.set(uri, document);
    return document;
  }

  remove(uri: string): void {
    this.documents.delete(uri);
  }

  async reload(uri: string): Promise<void> {
    try {
      const source = await fs.readFile(filePath(uri), "utf8");
      this.update(uri, source);
    } catch {
      this.remove(uri);
    }
  }

  get(uri: string): IndexedDocument | undefined {
    return this.documents.get(uri);
  }

  symbolAt(uri: string, position: { line: number; character: number }): IndexedSymbol | undefined {
    const document = this.documents.get(uri);
    if (!document) return undefined;
    const symbols = document.parsed.symbols.filter((symbol) => symbol.kind !== "import");
    const exact = symbols.find((symbol) => symbol.selectionRange.start.line === position.line && position.character >= symbol.selectionRange.start.character && position.character <= symbol.selectionRange.end.character);
    if (exact) return this.indexedSymbol(document, exact);
    const enclosing = [...symbols].reverse().find((symbol) => symbol.range.start.line <= position.line);
    return enclosing ? this.indexedSymbol(document, enclosing) : undefined;
  }

  enclosingSymbol(uri: string, line: number): IndexedSymbol | undefined {
    const document = this.documents.get(uri);
    if (!document) return undefined;
    const symbol = [...document.parsed.symbols]
      .filter((item) => item.kind !== "import" && item.range.start.line <= line)
      .sort((left, right) => right.range.start.line - left.range.start.line)[0];
    return symbol ? this.indexedSymbol(document, symbol) : undefined;
  }

  all(): IndexedDocument[] {
    return [...this.documents.values()];
  }

  symbols(): IndexedSymbol[] {
    return this.all().flatMap((document) => document.parsed.symbols
      .filter((symbol) => symbol.kind !== "import")
      .map((symbol) => this.indexedSymbol(document, symbol)));
  }

  async definition(uri: string, position: { line: number; character: number }): Promise<SymbolLocation | undefined> {
    await this.ready();
    const document = this.documents.get(uri);
    if (!document) return undefined;
    const identifier = identifierAt(document.source, position);
    if (!identifier) return undefined;
    const imported = this.importFor(document.parsed.imports, identifier);
    if (imported?.resolvedUri) {
      const target = this.documents.get(imported.resolvedUri);
      const member = identifier.split(".").slice(1).join(".");
      const found = target && this.findInDocument(target, member || identifier);
      if (found) return { symbol: this.indexedSymbol(target, found), uri: target.uri };
    }
    const local = this.findInDocument(document, identifier);
    if (local) return { symbol: this.indexedSymbol(document, local), uri };
    const candidates = this.symbols().filter((symbol) => symbol.name === identifier || localName(symbol.name) === localName(identifier));
    const sameDirectory = candidates.find((symbol) => path.dirname(filePath(symbol.uri)) === path.dirname(filePath(uri)));
    const found = sameDirectory ?? candidates[0];
    return found ? { symbol: found, uri: found.uri } : undefined;
  }

  async references(target: SymbolLocation): Promise<Array<{ uri: string; range: ReturnType<typeof rangeForLine> }>> {
    await this.ready();
    const name = localName(target.symbol.name);
    const expression = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
    const targetStart = target.symbol.selectionRange.start;
    const targetKey = `${target.uri}:${targetStart.line}:${targetStart.character}`;
    const locations: Array<{ uri: string; range: ReturnType<typeof rangeForLine> }> = [];
    for (const document of this.all()) {
      if (document.uri !== target.uri && !document.parsed.imports.some((item) => item.resolvedUri === target.uri)) continue;
      const lines = document.source.split(/\r?\n/);
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const line = lines[lineNumber] ?? "";
        const code = codeOnly(line);
        for (const match of code.matchAll(expression)) {
          const identifier = match[0];
          const memberStart = identifier.lastIndexOf(".") + 1;
          if (identifier.slice(memberStart) !== name) continue;
          const identifierStart = match.index ?? 0;
          const nameStart = identifierStart + memberStart;
          const resolved = await this.definition(document.uri, { line: lineNumber, character: nameStart });
          if (!resolved) continue;
          const resolvedStart = resolved.symbol.selectionRange.start;
          const resolvedKey = `${resolved.uri}:${resolvedStart.line}:${resolvedStart.character}`;
          if (resolvedKey !== targetKey) continue;
          locations.push({ uri: document.uri, range: rangeForLine(lineNumber, nameStart, nameStart + name.length) });
        }
      }
    }
    return locations;
  }

  async completionNames(): Promise<string[]> {
    await this.ready();
    return [...new Set(this.symbols().map((symbol) => symbol.name))].sort();
  }

  async completionSymbols(): Promise<IndexedSymbol[]> {
    await this.ready();
    return this.symbols();
  }

  private async loadWorkspace(): Promise<void> {
    const files = await bendFiles(this.workspaceRoot);
    let nextFile = 0;
    const loadNext = async (): Promise<void> => {
      while (nextFile < files.length) {
        const file = files[nextFile++];
        try {
          const source = await fs.readFile(file, "utf8");
          this.update(pathToFileURL(file).toString(), source);
        } catch {
          // Files may disappear while the workspace is being indexed.
        }
      }
    };
    const workers = Array.from({ length: Math.min(workspaceLoadConcurrency, files.length) }, () => loadNext());
    await Promise.all(workers);
  }

  private findInDocument(document: IndexedDocument, name: string): BendSymbol | undefined {
    return document.parsed.symbols.find((symbol) => symbol.name === name || localName(symbol.name) === localName(name));
  }

  private indexedSymbol(document: IndexedDocument, symbol: BendSymbol): IndexedSymbol {
    return { ...symbol, uri: document.uri, provenance: document.provenance };
  }

  private importFor(imports: BendImport[], identifier: string): BendImport | undefined {
    const alias = identifier.split(".")[0];
    return imports.find((item) => item.alias === alias);
  }
}
