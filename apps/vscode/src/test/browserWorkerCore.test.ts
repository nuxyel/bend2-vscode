import assert from "node:assert/strict";
import test from "node:test";
import { findBrowserDefinition, indexBrowserFiles, searchBrowserSymbols } from "../browserWorkerCore.js";

test("indexes browser files and resolves definitions across files", () => {
  const entries = indexBrowserFiles([
    { uri: "file:///workspace/main.bend", text: "def main():\n  helper()" },
    { uri: "file:///workspace/lib.bend", text: "def helper():\n  1" },
  ]);
  const location = findBrowserDefinition(entries, "file:///workspace/main.bend", "helper");
  assert.equal(location?.uri, "file:///workspace/lib.bend");
  assert.equal(location?.range.start.line, 0);
  assert.equal(location?.range.start.character, 4);
});

test("searches indexed browser symbols without VS Code runtime objects", () => {
  const entries = indexBrowserFiles([
    { uri: "file:///workspace/laws.bend", text: "law add_ok:\n  True" },
    { uri: "file:///workspace/types.bend", text: "type Option:\n  Some { value }" },
  ]);
  const symbols = searchBrowserSymbols(entries, "some");
  assert.deepEqual(symbols.map((symbol) => symbol.name), ["Option.Some"]);
  assert.equal(symbols[0]?.uri, "file:///workspace/types.bend");
});
