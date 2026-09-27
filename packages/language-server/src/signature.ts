export interface CallContext {
  name: string;
  nameStart: { line: number; character: number };
  activeParameter: number;
}

export interface ParsedSignature {
  label: string;
  parameters: string[];
}

const callKeywords = new Set(["if", "for", "match", "case", "def", "law", "type", "where"]);

/** Find the unmatched function call containing the cursor and its active argument. */
export function callContextAt(source: string, position: { line: number; character: number }): CallContext | undefined {
  if (position.line < 0 || position.character < 0) return undefined;
  let lineStart = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0) return undefined;
    lineStart = newline + 1;
  }
  if (lineStart > source.length) return undefined;
  const newline = source.indexOf("\n", lineStart);
  const lineEnd = newline < 0 ? source.length : newline - (source[newline - 1] === "\r" ? 1 : 0);
  const offset = lineStart + Math.min(position.character, lineEnd - lineStart);
  const code = maskStringsAndComments(source).slice(0, offset);
  const stack: Array<{ character: string; offset: number }> = [];
  const openingFor: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index] ?? "";
    if (character === "(" || character === "[" || character === "{") stack.push({ character, offset: index });
    else if (openingFor[character]) {
      const expected = openingFor[character];
      for (let cursor = stack.length - 1; cursor >= 0; cursor -= 1) {
        if (stack[cursor]?.character !== expected) continue;
        stack.splice(cursor);
        break;
      }
    }
  }
  const opening = [...stack].reverse().find((item) => item.character === "(");
  if (!opening) return undefined;
  const prefix = code.slice(0, opening.offset);
  const callee = /((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(prefix);
  const name = callee?.[1];
  if (!name || callKeywords.has(name)) return undefined;

  let activeParameter = 0;
  const argumentsText = code.slice(opening.offset + 1);
  const delimiters: string[] = [];
  for (const character of argumentsText) {
    if (character === "(" || character === "[" || character === "{") delimiters.push(character);
    else if (openingFor[character]) {
      const expected = openingFor[character];
      for (let cursor = delimiters.length - 1; cursor >= 0; cursor -= 1) {
        if (delimiters[cursor] !== expected) continue;
        delimiters.splice(cursor);
        break;
      }
    } else if (character === "," && delimiters.length === 0) activeParameter += 1;
  }

  const callLine = code.slice(0, opening.offset).split("\n").length - 1;
  const callLineStart = code.lastIndexOf("\n", opening.offset - 1) + 1;
  const nameStart = opening.offset - name.length - callLineStart;
  return { name, nameStart: { line: callLine, character: Math.max(0, nameStart) }, activeParameter };
}

/** Extract a declaration's parameters without depending on compiler internals. */
export function parseSignature(name: string, declaration: string): ParsedSignature | undefined {
  const code = maskStringsAndComments(declaration);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`\\b(?:def|law)\\s+${escapedName}\\s*\\(`).exec(code);
  if (!header) return undefined;
  const opening = code.indexOf("(", header.index + header[0].length - 1);
  if (opening < 0) return undefined;
  let depth = 0;
  let start = opening + 1;
  const parameters: string[] = [];
  for (let index = opening; index < code.length; index += 1) {
    const character = code[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        const last = declaration.slice(start, index).trim();
        if (last) parameters.push(last);
        return { label: `${name}(${parameters.join(", ")})`, parameters };
      }
    } else if (character === "," && depth === 1) {
      const parameter = declaration.slice(start, index).trim();
      if (parameter) parameters.push(parameter);
      start = index + 1;
    }
  }
  const last = declaration.slice(start).trim();
  if (last) parameters.push(last);
  return { label: `${name}(${parameters.join(", ")}`, parameters };
}

function maskStringsAndComments(source: string): string {
  const result = [...source];
  let quote = "";
  let escaped = false;
  for (let index = 0; index < result.length; index += 1) {
    const character = result[index] ?? "";
    if (quote) {
      result[index] = " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") {
      result[index] = " ";
      quote = character;
    } else if (character === "#") {
      while (index < result.length && result[index] !== "\n") result[index++] = " ";
    }
  }
  return result.join("");
}
