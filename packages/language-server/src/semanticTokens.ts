import { SemanticTokens, SemanticTokensBuilder } from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { codeOnly } from "./parser.js";

export const tokenTypes = ["keyword", "function", "type", "law", "variable", "comment", "number", "string"];
export const tokenModifiers: string[] = [];

export interface SemanticTokenRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export function semanticTokens(document: TextDocument, range?: SemanticTokenRange): SemanticTokens {
  const builder = new SemanticTokensBuilder();
  const lines = document.getText().split(/\r?\n/);
  lines.forEach((text, line) => {
    if (range && (line < range.start.line || line > range.end.line)) return;
    const code = codeOnly(text);
    const declaration = /\b(def|law|type)\s+((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)/.exec(code);
    if (declaration) {
      const keywordIndex = declaration.index;
      const nameIndex = keywordIndex + declaration[0].lastIndexOf(declaration[2]);
      builder.push(line, keywordIndex, declaration[1].length, tokenTypes.indexOf("keyword"), 0);
      builder.push(line, nameIndex, declaration[2].length, tokenTypes.indexOf(declaration[1] === "law" ? "law" : declaration[1] === "def" ? "function" : "type"), 0);
    }
    const comment = text.indexOf("#");
    if (comment >= 0) builder.push(line, comment, text.length - comment, tokenTypes.indexOf("comment"), 0);
  });
  return builder.build();
}
