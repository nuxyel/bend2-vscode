export interface BrowserDiagnosticRelatedInformation {
  line: number;
  start: number;
  end: number;
  message: string;
}

export interface BrowserDiagnostic {
  message: string;
  severity: "error" | "warning";
  line: number;
  start: number;
  end: number;
  relatedInformation?: BrowserDiagnosticRelatedInformation[];
}

function codeOnly(line: string): string {
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

export function parseBrowserDiagnostics(source: string): BrowserDiagnostic[] {
  const diagnostics: BrowserDiagnostic[] = [];
  const declarations = new Map<string, { line: number; start: number; end: number }>();
  for (const [line, text] of source.split(/\r?\n/).entries()) {
    const code = codeOnly(text);
    const declaration = /^\s*(?:(?:public|private)\s+)?(?:def|law|type)\s+((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)/.exec(code);
    if (declaration) {
      const name = declaration[1];
      const start = text.indexOf(name, declaration.index ?? 0);
      const range = { line, start, end: start + name.length };
      const previous = declarations.get(name);
      if (previous) {
        diagnostics.push({
          message: `Duplicate declaration '${name}'.`,
          severity: "error",
          ...range,
          relatedInformation: [{ ...previous, message: "First declaration" }],
        });
      } else declarations.set(name, range);
    }
    const hole = /\?(?:TODO|[A-Za-z_][A-Za-z0-9_]*)/.exec(code);
    if (hole) diagnostics.push({
      message: `Open proof goal '${hole[0]}'.`,
      severity: "warning",
      line,
      start: hole.index,
      end: hole.index + hole[0].length,
    });
    const unsafe = /@unsafe\b/.exec(code);
    if (unsafe) diagnostics.push({
      message: "Unsafe proof marker requires explicit UNSAFE_OK review.",
      severity: "warning",
      line,
      start: unsafe.index,
      end: unsafe.index + "@unsafe".length,
    });
    const foreign = /^\s*foreign\b/.exec(code);
    if (foreign) {
      const start = text.indexOf("foreign");
      diagnostics.push({
        message: "Foreign proof dependency requires explicit review.",
        severity: "warning",
        line,
        start: Math.max(0, start),
        end: Math.max(0, start) + "foreign".length,
      });
    }
  }
  return diagnostics;
}
