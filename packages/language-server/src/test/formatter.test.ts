import assert from "node:assert/strict";
import test from "node:test";
import { formatBend } from "../officialFormatter.js";

test("formats Bend 2 while preserving comments, line endings and final-newline state", () => {
  const source = "def  add(x:Nat)->Nat:\r\n    # keep this comment\r\n    x+1n";
  const formatted = formatBend(source, { tabSize: 2, insertSpaces: true });
  assert.equal(formatted, "def add(x: Nat) -> Nat:\r\n  # keep this comment\r\n  x + 1n");
  assert.equal(formatted.endsWith("\n"), false);
});

test("returns the source unchanged when a literal is incomplete", () => {
  const source = "def broken():\n  \"unterminated";
  assert.equal(formatBend(source), source);
});
