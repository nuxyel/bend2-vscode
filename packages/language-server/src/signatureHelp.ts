export interface BendSignatureParameter {
  label: string;
  documentation?: string;
}

export interface BendSignature {
  label: string;
  parameters: BendSignatureParameter[];
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return i;
  }
  return -1;
}

function splitParameters(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if ("([{<".includes(char)) depth += 1;
    else if (")]}".includes(char) || char === ">") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const tail = text.slice(start).trim();
  if (tail || result.length) result.push(tail);
  return result.filter(Boolean);
}

export function parseBendSignature(source: string, name: string): BendSignature | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`^\\s*(?:(?:public|private)\\s+)?def\\s+${escaped}\\s*\\(`, "m");
  const match = declaration.exec(source);
  if (!match) return undefined;
  const open = source.indexOf("(", match.index + match[0].length - 1);
  const close = matchingParen(source, open);
  const paramsText = source.slice(open + 1, close < 0 ? source.length : close);
  const parameters = splitParameters(paramsText).map((label) => ({ label }));
  const end = close < 0 ? source.length : close + 1;
  const label = source.slice(match.index, end).replace(/\s+/g, " ").trim();
  return { label, parameters };
}

export function callContextAt(source: string, offset: number): { name: string; activeParameter: number } | undefined {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let commas = 0;
  let foundCall = false;
  let callOpen = -1;
  for (let i = Math.min(offset - 1, source.length - 1); i >= 0; i -= 1) {
    const char = source[i] ?? "";
    if (char === ")") depth += 1;
    else if (char === "(") {
      if (depth > 0) depth -= 1;
      else { foundCall = true; callOpen = i; break; }
    } else if (char === "," && depth === 0) commas += 1;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") quote = char;
  }
  if (!foundCall) return undefined;
  const beforeParen = source.slice(0, callOpen).replace(/\s+$/, "");
  const name = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(beforeParen)?.[1];
  return name ? { name, activeParameter: commas } : undefined;
}
