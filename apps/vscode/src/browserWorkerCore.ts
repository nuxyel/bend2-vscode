export interface BrowserWorkerFile {
  uri: string;
  text: string;
}

export interface BrowserWorkerRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface BrowserWorkerSymbol {
  name: string;
  detail: string;
  kind: number;
  range: BrowserWorkerRange;
  selectionRange: BrowserWorkerRange;
}

export interface BrowserWorkerEntry extends BrowserWorkerFile {
  symbols: BrowserWorkerSymbol[];
}

export interface BrowserWorkerLocation {
  uri: string;
  range: BrowserWorkerRange;
}

export interface BrowserWorkerSymbolInformation {
  name: string;
  kind: number;
  range: BrowserWorkerRange;
  uri: string;
}

export function indexBrowserFiles(files: BrowserWorkerFile[]): BrowserWorkerEntry[] {
  return files.map((file) => ({ ...file, symbols: browserSymbols(file.text) }));
}

export function findBrowserDefinition(entries: BrowserWorkerEntry[], currentUri: string, qualifiedName: string): BrowserWorkerLocation | undefined {
  const name = qualifiedName.split(".").pop() ?? qualifiedName;
  for (const entry of entries) {
    if (entry.uri === currentUri) continue;
    const symbol = entry.symbols.find((candidate) => candidate.name === qualifiedName || candidate.name.split(".").pop() === name);
    if (symbol) return { uri: entry.uri, range: symbol.selectionRange };
  }
  return undefined;
}

export function searchBrowserSymbols(entries: BrowserWorkerEntry[], query: string): BrowserWorkerSymbolInformation[] {
  const normalizedQuery = query.trim().toLowerCase();
  const results: BrowserWorkerSymbolInformation[] = [];
  for (const entry of entries) {
    for (const symbol of entry.symbols) {
      if (normalizedQuery && !symbol.name.toLowerCase().includes(normalizedQuery)) continue;
      results.push({ name: symbol.name, kind: symbol.kind, range: symbol.range, uri: entry.uri });
    }
  }
  return results;
}

function browserSymbols(source: string): BrowserWorkerSymbol[] {
  const symbols: BrowserWorkerSymbol[] = [];
  let activeType: string | undefined;
  for (const [line, text] of source.split(/\r?\n/).entries()) {
    if (activeType && text.trim() && !/^\s/.test(text)) activeType = undefined;
    const match = /^\s*(?:(?:public|private)\s+)?(def|law|type)\s+((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)/.exec(text);
    if (match) {
      const name = match[2];
      const start = text.indexOf(name, match.index ?? 0);
      const range = lineRange(line, text.length);
      const selectionRange = { start: { line, character: start }, end: { line, character: start + name.length } };
      const kind = match[1] === "type" ? 23 : match[1] === "law" ? 24 : 12;
      symbols.push({ name, detail: match[1], kind, range, selectionRange });
      activeType = match[1] === "type" ? name : undefined;
      continue;
    }
    if (activeType) {
      const constructor = /^\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{/.exec(text);
      if (constructor) {
        const localName = constructor[1];
        const name = `${activeType}.${localName}`;
        const start = text.indexOf(localName, constructor.index ?? 0);
        symbols.push({
          name,
          detail: `constructor ${name}`,
          kind: 9,
          range: lineRange(line, text.length),
          selectionRange: { start: { line, character: start }, end: { line, character: start + localName.length } },
        });
      }
    }
  }
  return symbols;
}

function lineRange(line: number, length: number): BrowserWorkerRange {
  return { start: { line, character: 0 }, end: { line, character: length } };
}
