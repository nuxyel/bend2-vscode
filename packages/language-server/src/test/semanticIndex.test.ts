import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { BendWorkspaceIndex } from "../semanticIndex.js";

test("resolves imported definitions and indexes references across Bend files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-index-"));
  const mainPath = path.join(root, "main.bend");
  const libPath = path.join(root, "lib.bend");
  const unrelatedPath = path.join(root, "other.bend");
  await fs.writeFile(mainPath, "import ./lib.bend as Lib\ndef use():\n  Lib.helper()\n");
  await fs.writeFile(libPath, "def helper():\n  1n\n# helper should not count\n");
  await fs.writeFile(unrelatedPath, "def helper():\n  2n\n");

  const mainUri = pathToFileURL(mainPath).toString();
  const libUri = pathToFileURL(libPath).toString();
  const index = new BendWorkspaceIndex(root);
  index.initialize();
  await index.ready();

  const definition = await index.definition(mainUri, { line: 2, character: 7 });
  assert.equal(definition?.uri, libUri);
  assert.equal(definition?.symbol.name, "helper");
  assert.deepEqual(definition?.symbol.provenance, { source: "tolerant-parser", provisional: true, compilerVersion: null });
  assert.deepEqual(index.get(libUri)?.provenance, { source: "tolerant-parser", provisional: true, compilerVersion: null });
  index.setCompilerVersion("2.0.16");
  assert.equal(index.get(libUri)?.provenance.compilerVersion, "2.0.16");

  assert.equal(index.symbolAt(libUri, { line: 0, character: 5 })?.name, "helper");
  assert.equal(index.enclosingSymbol(mainUri, 2)?.name, "use");

  const references = await index.references(definition!);
  assert.equal(references.length, 2);
  assert.deepEqual(references.map((item) => item.uri).sort(), [libUri, mainUri].sort());
});

test("excludes homonymous local declarations from imported symbol references", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-index-homonym-"));
  try {
    const mainPath = path.join(root, "main.bend");
    const libraryPath = path.join(root, "library.bend");
    await fs.writeFile(mainPath, [
      "import ./library.bend as Library",
      "def helper():",
      "  0n",
      "def use():",
      "  Library.helper()",
      "  helper()",
      "",
    ].join("\n"));
    await fs.writeFile(libraryPath, "def helper():\n  1n\n");

    const mainUri = pathToFileURL(mainPath).toString();
    const libraryUri = pathToFileURL(libraryPath).toString();
    const index = new BendWorkspaceIndex(root);
    index.initialize();
    await index.ready();

    const importedTarget = await index.definition(mainUri, { line: 4, character: 12 });
    assert.equal(importedTarget?.uri, libraryUri);
    const references = await index.references(importedTarget!);
    assert.deepEqual(references.map(({ uri, range }) => ({ uri, line: range.start.line, character: range.start.character }))
      .sort((left, right) => left.uri.localeCompare(right.uri)), [
      { uri: libraryUri, line: 0, character: 4 },
      { uri: mainUri, line: 4, character: 10 },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("indexes Bend 2 constructors as qualified symbols", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-constructor-index-"));
  try {
    const mainPath = path.join(root, "main.bend");
    await fs.writeFile(mainPath, "type Option is Data:\n  Some{value: Nat}\n  None{}\n\ndef make():\n  Some{1}\n");
    const uri = pathToFileURL(mainPath).toString();
    const index = new BendWorkspaceIndex(root);
    index.initialize();
    await index.ready();
    const definition = await index.definition(uri, { line: 5, character: 3 });
    assert.equal(definition?.symbol.name, "Option.Some");
    assert.equal(definition?.symbol.kind, "constructor");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reloads changed files and removes deleted files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-index-reload-"));
  try {
    const filePath = path.join(root, "changed.bend");
    await fs.writeFile(filePath, "def before():\n  1n\n");
    const uri = pathToFileURL(filePath).toString();
    const index = new BendWorkspaceIndex(root);
    index.initialize();
    await index.ready();
    assert.equal(index.get(uri)?.parsed.symbols[0]?.name, "before");
    await fs.writeFile(filePath, "def after():\n  2n\n");
    await index.reload(uri);
    assert.equal(index.get(uri)?.parsed.symbols[0]?.name, "after");
    await fs.rm(filePath);
    await index.reload(uri);
    assert.equal(index.get(uri), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("indexes a large workspace with bounded file loading", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bend2-index-large-"));
  try {
    const fileCount = 120;
    await Promise.all(Array.from({ length: fileCount }, (_, index) => fs.writeFile(path.join(root, `module-${index}.bend`), `def generated${index}():\n  ${index}n\n`)));
    const index = new BendWorkspaceIndex(root);
    index.initialize();
    await index.ready();
    assert.equal(index.all().length, fileCount);
    assert.equal(index.symbols().filter((symbol) => symbol.name.startsWith("generated")).length, fileCount);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
