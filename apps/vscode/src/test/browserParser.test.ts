import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserDiagnostics } from "../browserParser.js";

test("finds duplicate declarations and preserves the first location", () => {
  const diagnostics = parseBrowserDiagnostics("def run():\n  0n\ndef run():\n  1n\n");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.message, "Duplicate declaration 'run'.");
  assert.deepEqual(diagnostics[0]?.relatedInformation?.[0], { line: 0, start: 4, end: 7, message: "First declaration" });
});

test("finds open goals while ignoring comments and strings", () => {
  const diagnostics = parseBrowserDiagnostics("# ?TODO\ndef proof():\n  \"?hidden\"\n  ?goal\n");
  assert.deepEqual(diagnostics.map((item) => item.message), ["Open proof goal '?goal'."]);
  assert.equal(diagnostics[0]?.line, 3);
});

test("reports unsafe and foreign markers while ignoring comments and strings", () => {
  const diagnostics = parseBrowserDiagnostics("def proof():\n  \"@unsafe foreign\"\n  @unsafe\n  foreign helper\n# foreign ignored\n");
  assert.deepEqual(diagnostics.map((item) => item.message), [
    "Unsafe proof marker requires explicit UNSAFE_OK review.",
    "Foreign proof dependency requires explicit review.",
  ]);
});
