import assert from "node:assert/strict";
import test from "node:test";
import { TextDocument } from "vscode-languageserver-textdocument";
import { semanticTokens, tokenTypes } from "../semanticTokens.js";

function decodeLines(data: number[]): number[] {
  const lines: number[] = [];
  let line = 0;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index] ?? 0;
    lines.push(line);
  }
  return lines;
}

test("returns full-document semantic tokens with the declared legend", () => {
  const document = TextDocument.create("file:///main.bend", "bend", 1, "def first():\nlaw second:\n  ?TODO\ntype Third:\n");
  const result = semanticTokens(document);
  assert.ok(result.data.length >= 15);
  assert.equal(result.data[3], tokenTypes.indexOf("keyword"));
  assert.deepEqual(decodeLines(result.data), [0, 0, 1, 1, 3, 3]);
});

test("range semantic tokens contain only requested lines", () => {
  const document = TextDocument.create("file:///main.bend", "bend", 1, "def first():\nlaw second:\n  ?TODO\ntype Third:\n");
  const result = semanticTokens(document, { start: { line: 1, character: 0 }, end: { line: 1, character: 11 } });
  assert.deepEqual(decodeLines(result.data), [1, 1]);
});
