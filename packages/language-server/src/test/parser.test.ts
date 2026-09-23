import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parallelBalanceDiagnostic, parseBend, wordAt } from "../parser.js";

const fixtures = path.basename(process.cwd()) === "language-server"
  ? path.join(process.cwd(), "src", "test", "fixtures")
  : path.join(process.cwd(), "packages", "language-server", "src", "test", "fixtures");

async function fixture(name: string): Promise<string> {
  return fs.readFile(path.join(fixtures, name), "utf8");
}

test("parses Bend declarations and exposes symbols", () => {
  const parsed = parseBend("def add(x: Nat):\n  x\nlaw add_ok:\n  ?TODO\n");
  assert.deepEqual(parsed.symbols.map((item) => item.name), ["add", "add_ok"]);
  assert.equal(parsed.symbols[0]?.kind, "function");
  assert.equal(parsed.diagnostics[0]?.message, "Open proof goal '?TODO'.");
});

test("reports duplicate declarations", () => {
  const parsed = parseBend("def run():\n  0n\ndef run():\n  1n\n");
  assert.equal(parsed.diagnostics[0]?.message, "Duplicate declaration 'run'.");
});

test("finds a word at a source position", () => {
  assert.equal(wordAt("def hello():", { line: 0, character: 6 }), "hello");
  assert.equal(wordAt("def hello():", { line: 0, character: 0 }), "def");
});

test("understands qualified proof definitions and Bend 2 type declarations", () => {
  const parsed = parseBend("type Trip is Data:\n  Trip{free, sold}\n\ndef Laws.seats_kept(cap, ops):\n  Core.seats(cap)\n");
  assert.deepEqual(parsed.symbols.map((item) => item.name), ["Trip", "Trip.Trip", "Laws.seats_kept"]);
  assert.equal(parsed.symbols[1]?.kind, "constructor");
  assert.equal(parsed.symbols[2]?.kind, "function");
  assert.equal(parsed.diagnostics.length, 0);
});

test("ignores declarations and proof holes inside comments and strings", () => {
  const parsed = parseBend("# def fake(): ?TODO\ndef real():\n  \"law hidden ?TODO\"\n");
  assert.deepEqual(parsed.symbols.map((item) => item.name), ["real"]);
  assert.equal(parsed.diagnostics.length, 0);
});

test("reports unsafe and foreign proof markers while ignoring quoted text", () => {
  const parsed = parseBend("def proof():\n  \"@unsafe foreign\"\n  @unsafe\n  foreign helper\n# foreign ignored\n");
  assert.deepEqual(parsed.diagnostics.map((diagnostic) => diagnostic.message), [
    "Unsafe proof marker requires explicit UNSAFE_OK review.",
    "Foreign proof dependency requires explicit review.",
  ]);
});

test("reports useful diagnostics for a malformed fixture", async () => {
  const parsed = parseBend(await fixture("malformed.bend"), path.join(fixtures, "malformed.bend"));
  assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes("Cannot resolve local import")));
  assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes("Duplicate declaration")));
  assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes("Open proof goal")));
});

test("keeps incomplete input safe to parse", async () => {
  const parsed = parseBend(await fixture("incomplete.bend"));
  assert.ok(Array.isArray(parsed.symbols));
  assert.ok(Array.isArray(parsed.diagnostics));
});

test("handles a large repeated fixture without losing symbols", async () => {
  const source = await fixture("large.bend");
  const repeated = Array.from({ length: 125 }, () => source).join("\n");
  const started = performance.now();
  const parsed = parseBend(repeated);
  const elapsed = performance.now() - started;
  assert.equal(parsed.symbols.length, 8);
  assert.ok(elapsed < 1_000, `large fixture parse took ${elapsed.toFixed(1)}ms`);
});

test("warns only when parallel call branches are syntactically very unbalanced", () => {
  assert.equal(parallelBalanceDiagnostic("  a b = work(x) work(y)", 2), undefined);
  const diagnostic = parallelBalanceDiagnostic("  a b = tiny(x) extremely_expensive_name_with_many_arguments(x, y, z)", 3);
  assert.match(diagnostic?.message ?? "", /unbalanced fork\/join/);
  assert.equal(parallelBalanceDiagnostic("  a b = work(x) 0n", 4), undefined);
});

test("keeps the unbalanced parallel warning covered by a Bend fixture", async () => {
  const parsed = parseBend(await fixture("unbalanced-parallel.bend"));
  assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes("unbalanced fork/join")));
});
