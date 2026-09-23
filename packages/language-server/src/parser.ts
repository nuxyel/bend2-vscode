import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

export type SymbolKindName = "function" | "law" | "type" | "data" | "constructor" | "import";

export interface SourcePosition {
  line: number;
  character: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface BendSymbol {
  name: string;
  kind: SymbolKindName;
  detail: string;
  range: SourceRange;
  selectionRange: SourceRange;
}

export interface BendDiagnostic {
  message: string;
  severity: "error" | "warning" | "info";
  range: SourceRange;
  source: "bend2-parser" | "bend2-proof";
}

export interface BendImport {
  path: string;
  alias: string;
  range: SourceRange;
  resolvedUri?: string;
}

export interface ParsedDocument {
  symbols: BendSymbol[];
  diagnostics: BendDiagnostic[];
  words: Set<string>;
  imports: BendImport[];
}

const declarationPattern = /^(\s*)(?:(?:public|private)\s+)?(def|law|type)\s+((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)/;
const importPattern = /^\s*import\s+([^\s]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/;
const constructorPattern = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\{/;
const wordPattern = /[A-Za-z_][A-Za-z0-9_]*/g;

function range(line: number, start: number, end: number): SourceRange {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

function kindFor(keyword: string): SymbolKindName {
  if (keyword === "def") return "function";
  if (keyword === "law") return "law";
  return "type";
}

export function resolveLocalImport(uri: string, importPath: string): string | undefined {
  if (!importPath.startsWith(".")) return undefined;
  if (!uri) return undefined;
  const sourcePath = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  const base = path.resolve(path.dirname(sourcePath), importPath);
  const candidates = [base, `${base}.bend`, path.join(base, "main.bend")];
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return found ? pathToFileURL(found).toString() : undefined;
}

function localImportExists(uri: string, importPath: string): boolean {
  return !importPath.startsWith(".") || Boolean(resolveLocalImport(uri, importPath));
}

function parallelBranches(rhs: string): [string, string] | undefined {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < rhs.length; index += 1) {
    const char = rhs[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ("([{<".includes(char)) depth += 1;
    else if (")]}>".includes(char)) depth = Math.max(0, depth - 1);
    else if (/\s/.test(char) && depth === 0 && index > 0) {
      const left = rhs.slice(0, index).trim();
      const right = rhs.slice(index).trim();
      if (left && right && /[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(left) && /[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(right)) {
        return [left, right];
      }
    }
  }
  return undefined;
}

export function parallelBalanceDiagnostic(lineText: string, line: number): BendDiagnostic | undefined {
  const code = codeOnly(lineText);
  const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/.exec(code);
  if (!assignment) return undefined;
  const rhsStart = lineText.indexOf(assignment[1]);
  const branches = parallelBranches(assignment[1]);
  if (!branches) return undefined;
  const [left, right] = branches;
  const larger = Math.max(left.replace(/\s+/g, "").length, right.replace(/\s+/g, "").length);
  const smaller = Math.min(left.replace(/\s+/g, "").length, right.replace(/\s+/g, "").length);
  if (smaller < 1 || larger < smaller * 3) return undefined;
  return {
    message: "Parallel branches have very different syntactic sizes; this may be an unbalanced fork/join. Measure before relying on a performance gain.",
    severity: "warning",
    range: range(line, Math.max(0, rhsStart), lineText.length),
    source: "bend2-parser",
  };
}

export function codeOnly(line: string): string {
  const chars = [...line];
  let quote = "";
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (quote) {
      chars[index] = " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
      chars[index] = " ";
    } else if (char === "#") {
      for (let rest = index; rest < chars.length; rest += 1) chars[rest] = " ";
      break;
    }
  }
  return chars.join("");
}

export function parseBend(source: string, uri = ""): ParsedDocument {
  const symbols: BendSymbol[] = [];
  const diagnostics: BendDiagnostic[] = [];
  const words = new Set<string>();
  const imports: BendImport[] = [];
  const seen = new Map<string, BendSymbol>();
  const lines = source.split(/\r?\n/);
  let activeType: string | undefined;

  lines.forEach((lineText, line) => {
    const code = codeOnly(lineText);
    for (const match of code.matchAll(wordPattern)) words.add(match[0]);

    if (activeType && code.trim() && !/^\s/.test(lineText)) activeType = undefined;

    const declaration = declarationPattern.exec(code);
    if (declaration) {
      const keyword = declaration[2];
      const name = declaration[3];
      const nameStart = declaration.index + declaration[0].lastIndexOf(name);
      const symbol: BendSymbol = {
        name,
        kind: kindFor(keyword),
        detail: `${keyword} ${name}`,
        range: range(line, declaration.index, lineText.length),
        selectionRange: range(line, nameStart, nameStart + name.length),
      };
      const previous = seen.get(name);
      if (previous) {
        diagnostics.push({
          message: `Duplicate declaration '${name}'.`,
          severity: "error",
          range: symbol.selectionRange,
          source: "bend2-parser",
        });
      } else {
        seen.set(name, symbol);
        symbols.push(symbol);
      }
      activeType = keyword === "type" ? name : undefined;
    } else if (activeType) {
      const constructor = constructorPattern.exec(code);
      if (constructor && /^\s+/.test(lineText)) {
        const localName = constructor[1];
        const name = `${activeType}.${localName}`;
        const nameStart = code.indexOf(localName, constructor.index);
        const symbol: BendSymbol = {
          name,
          kind: "constructor",
          detail: `constructor ${name}`,
          range: range(line, constructor.index, lineText.length),
          selectionRange: range(line, nameStart, nameStart + localName.length),
        };
        const previous = seen.get(name);
        if (previous) {
          diagnostics.push({
            message: `Duplicate declaration '${name}'.`,
            severity: "error",
            range: symbol.selectionRange,
            source: "bend2-parser",
          });
        } else {
          seen.set(name, symbol);
          symbols.push(symbol);
        }
      }
    }

    const imported = importPattern.exec(code);
    if (imported) {
      const importPath = imported[1];
      const alias = imported[2] ?? importPath.split(/[\\/]/).pop()?.replace(/\.bend$/, "") ?? importPath;
      const start = code.indexOf(importPath);
      symbols.push({
        name: alias,
        kind: "import",
        detail: `import ${importPath}`,
        range: range(line, 0, lineText.length),
        selectionRange: range(line, start, start + importPath.length),
      });
      imports.push({
        path: importPath,
        alias,
        range: range(line, start, start + importPath.length),
        resolvedUri: resolveLocalImport(uri, importPath),
      });
      if (!localImportExists(uri, importPath)) {
        diagnostics.push({
          message: `Cannot resolve local import '${importPath}'.`,
          severity: "error",
          range: range(line, start, start + importPath.length),
          source: "bend2-parser",
        });
      }
    }

    const hole = /\?(?:TODO|[A-Za-z_][A-Za-z0-9_]*)/.exec(code);
    if (hole) {
      diagnostics.push({
        message: `Open proof goal '${hole[0]}'.`,
        severity: "warning",
        range: range(line, hole.index, hole.index + hole[0].length),
        source: "bend2-proof",
      });
    }
    const unsafe = /^\s*@unsafe\b/.exec(code);
    if (unsafe) {
      const start = lineText.indexOf("@unsafe");
      diagnostics.push({
        message: "Unsafe proof marker requires explicit UNSAFE_OK review.",
        severity: "warning",
        range: range(line, Math.max(0, start), Math.max(0, start) + "@unsafe".length),
        source: "bend2-proof",
      });
    }
    const foreign = /^\s*foreign\b/.exec(code);
    if (foreign) {
      const start = lineText.indexOf("foreign");
      diagnostics.push({
        message: "Foreign proof dependency requires explicit review.",
        severity: "warning",
        range: range(line, Math.max(0, start), Math.max(0, start) + "foreign".length),
        source: "bend2-proof",
      });
    }
    const parallelDiagnostic = parallelBalanceDiagnostic(lineText, line);
    if (parallelDiagnostic) diagnostics.push(parallelDiagnostic);
  });

  return { symbols, diagnostics, words, imports };
}

export function wordAt(source: string, position: SourcePosition): string | undefined {
  const line = codeOnly(source.split(/\r?\n/)[position.line] ?? "");
  for (const match of line.matchAll(wordPattern)) {
    const start = match.index ?? 0;
    if (position.character >= start && position.character <= start + match[0].length) return match[0];
  }
  return undefined;
}

export function identifierAt(source: string, position: SourcePosition): string | undefined {
  const line = codeOnly(source.split(/\r?\n/)[position.line] ?? "");
  const qualifiedPattern = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
  for (const match of line.matchAll(qualifiedPattern)) {
    const start = match.index ?? 0;
    if (position.character >= start && position.character <= start + match[0].length) return match[0];
  }
  return undefined;
}
