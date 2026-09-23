export interface ProofGoalLocation {
  token: string;
  offset: number;
  line: number;
  character: number;
}

export type ProofStatus = "proved" | "open" | "failed" | "unsafe" | "foreign" | "not checked" | "missing proof";

export function unsafeAllowlist(source: string): Set<string> {
  const entries = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const entry = line.replace(/\s+#.*$/, "").replace(/\s+/g, "").trim();
    if (entry && !entry.startsWith("#")) entries.add(entry);
  }
  return entries;
}

export function unsafeReview(dependencies: string[], allowlist: Set<string>): { reviewed: string[]; unlisted: string[] } {
  const unique = [...new Set(dependencies)].sort((left, right) => left.localeCompare(right));
  return {
    reviewed: unique.filter((dependency) => allowlist.has(dependency)),
    unlisted: unique.filter((dependency) => !allowlist.has(dependency)),
  };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeOnly(line: string): string {
  const chars = [...line];
  let quote = "";
  let escapedQuote = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (quote) {
      chars[index] = " ";
      if (escapedQuote) escapedQuote = false;
      else if (char === "\\") escapedQuote = true;
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

export function proofBody(source: string, lawName: string): string | undefined {
  const declaration = new RegExp(`^\\s*def\\s+(?:Laws\\.)?${escaped(lawName)}(?=\\s|\\(|:)`, "m");
  const match = declaration.exec(source);
  if (!match) return undefined;
  const rest = source.slice(match.index);
  const nextDefinition = rest.slice(1).search(/^\s*def\s+/m);
  return nextDefinition >= 0 ? rest.slice(0, nextDefinition + 1) : rest;
}

export function proofGoal(source: string, lawName: string): ProofGoalLocation | undefined {
  const body = proofBody(source, lawName);
  if (!body) return undefined;
  const maskedBody = body.split(/(\r?\n)/).map((part) => part.includes("\n") ? part : codeOnly(part)).join("");
  const match = /\?(?:TODO|[A-Za-z_][A-Za-z0-9_]*)/.exec(maskedBody);
  if (!match) return undefined;
  const offset = source.indexOf(body) + match.index;
  const before = source.slice(0, offset);
  const line = before.split(/\r?\n/).length - 1;
  const lastBreak = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
  return { token: match[0], offset, line, character: offset - lastBreak - 1 };
}

export function proofStatus(source: string, lawName: string, compilerStatus?: "passed" | "failed", compilerAvailable = false): ProofStatus {
  if (!source) return "missing proof";
  const body = proofBody(source, lawName);
  if (!body) return "missing proof";
  if (compilerStatus === "failed") return "failed";
  if (/^\s*@unsafe\b/m.test(body)) return "unsafe";
  if (/^\s*foreign\b/m.test(body)) return "foreign";
  if (compilerStatus === "passed") return "proved";
  if (/\?(?:TODO|[A-Za-z_][A-Za-z0-9_]*)/.test(body)) return "open";
  return compilerAvailable ? "proved" : "not checked";
}
