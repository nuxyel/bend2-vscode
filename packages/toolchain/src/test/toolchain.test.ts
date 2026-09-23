import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BendToolchain, backendCapability, cancelToolchainProcesses, compilerCompatibility, compilerUnavailableMessage, loadDifferentialManifest, parseBendErrorDiagnostics, parseBendSafetyReport, parseCompilerCapabilities, parseCompilerDiagnostics, parseDifferentialManifest, parseStructuredDiagnostics, parseStructuredDiagnosticsDetailed, runToolchain, runtimeArguments, shouldRetryCheckOnly, shouldRetryTextDiagnostics } from "../toolchain.js";

test("parses Unix compiler diagnostics", () => {
  const diagnostics = parseCompilerDiagnostics("main.bend:12:7: error: expected Nat\nmain.bend:14:1: warning: open goal", "main.bend");
  assert.deepEqual(diagnostics, [
    { file: "main.bend", line: 11, column: 6, message: "expected Nat", severity: "error" },
    { file: "main.bend", line: 13, column: 0, message: "open goal", severity: "warning", category: "proof-goal" },
  ]);
});

test("detects when the experimental JSON flag needs a text fallback", () => {
  assert.equal(shouldRetryTextDiagnostics({ code: 2, stdout: "", stderr: "unknown option --diagnostics=json", timedOut: false, cancelled: false }), true);
  assert.equal(shouldRetryTextDiagnostics({ code: 1, stdout: "", stderr: "main.bend:2:3: error: type mismatch", timedOut: false, cancelled: false }), false);
  assert.equal(shouldRetryTextDiagnostics({ code: null, stdout: "", stderr: "unknown option --diagnostics=json", timedOut: false, cancelled: true }), false);
});

test("detects when the check-only flag needs a compatibility fallback", () => {
  assert.equal(shouldRetryCheckOnly({ code: 2, stdout: "", stderr: "unknown option --check-only", timedOut: false, cancelled: false }), true);
  assert.equal(shouldRetryCheckOnly({ code: 1, stdout: "", stderr: "main.bend:2:3: error: type mismatch", timedOut: false, cancelled: false }), false);
  assert.equal(shouldRetryCheckOnly({ code: null, stdout: "", stderr: "unknown option --check-only", timedOut: false, cancelled: true }), false);
});

test("does not spawn a command when cancellation already happened", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runToolchain({ command: "command-that-must-not-start", argsPrefix: [], source: "path", displayPath: "command-that-must-not-start" }, [], { cwd: process.cwd(), signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.code, null);
});

test("cancels and cleans up an active compiler process", async () => {
  const controller = new AbortController();
  const promise = runToolchain({ command: process.execPath, argsPrefix: [], source: "configured", displayPath: process.execPath }, ["-e", "setTimeout(() => {}, 30000)"], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  const result = await promise;
  assert.equal(result.cancelled, true);
  assert.equal(result.code, null);
});

test("cancels all active compiler processes during shutdown", async () => {
  const promise = runToolchain({ command: process.execPath, argsPrefix: [], source: "configured", displayPath: process.execPath }, ["-e", "setTimeout(() => {}, 30000)"], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancelToolchainProcesses();
  const result = await promise;
  assert.equal(result.cancelled, true);
  assert.equal(result.code, null);
});

test("parses Windows compiler diagnostics", () => {
  const diagnostics = parseCompilerDiagnostics("C:\\work\\main.bend(3,5): error: invalid pattern", "main.bend");
  assert.equal(diagnostics[0]?.file, "C:\\work\\main.bend");
  assert.equal(diagnostics[0]?.line, 2);
  assert.equal(diagnostics[0]?.column, 4);
});

test("classifies proof-related text diagnostics without losing source locations", () => {
  const diagnostics = parseCompilerDiagnostics([
    "proof.bend:2:1: error: foreign dependency used",
    "proof.bend:3:1: error: unsafe proof marker",
    "proof.bend:4:1: error: import failed",
  ].join("\n"), "proof.bend");
  assert.deepEqual(diagnostics.map(({ category, severity }) => ({ category, severity })), [
    { category: "foreign", severity: "warning" },
    { category: "unsafe", severity: "warning" },
    { category: "import", severity: "error" },
  ]);
});

test("parses the current Bend CLI Error and Location report", async () => {
  const fixtureRoot = path.join(process.cwd(), "src", "test", "fixtures");
  const output = await readFile(path.join(fixtureRoot, "compiler-diagnostics.bend-error"), "utf8");
  const metadata = JSON.parse(await readFile(path.join(fixtureRoot, "compiler-diagnostics.bend-error.meta.json"), "utf8")) as { version: string; revision: string; command: string[] };
  assert.equal(metadata.version, "2.0.23");
  assert.equal(metadata.revision, "fd7d9e652f31ca4ec560d36f159954aece108795");
  assert.deepEqual(metadata.command, ["bend", "file.bend", "--check-only"]);
  const diagnostics = parseBendErrorDiagnostics(output, "main.bend");
  assert.deepEqual(diagnostics, [
    {
      file: "main.bend",
      line: 1,
      column: 0,
      message: "expected a name (got the keyword 'match'); observed ' '",
      severity: "error",
      expectedType: "a name (got the keyword 'match')",
      observedType: "' '",
    },
    {
      file: "main.bend",
      line: 0,
      column: 0,
      message: "no such file: missing.bend",
      severity: "error",
      category: "import",
    },
  ]);
  assert.deepEqual(parseCompilerDiagnostics(output, "main.bend"), diagnostics);
});

test("parses successful Bend checks that report unsafe or foreign dependencies", async () => {
  const fixtureRoot = path.join(process.cwd(), "src", "test", "fixtures");
  const output = await readFile(path.join(fixtureRoot, "compiler-safety-report.txt"), "utf8");
  const sourceFile = path.join(fixtureRoot, "compiler-safety-report.bend");
  const diagnostics = parseBendSafetyReport(output, sourceFile);
  assert.deepEqual(diagnostics, [{
    file: sourceFile,
    line: 3,
    column: 4,
    endLine: 3,
    endColumn: 12,
    message: "Definition 'innocent' relies on unsafe or foreign code.",
    severity: "warning",
    category: "unsafe",
  }]);
  assert.deepEqual(parseCompilerDiagnostics(output, sourceFile), diagnostics);
});

test("parses structured compiler diagnostics", () => {
  const diagnostics = parseStructuredDiagnostics(JSON.stringify({ diagnostics: [{
    file: "main.bend",
    start: { line: 4, column: 2 },
    end: { line: 4, column: 8 },
    severity: "warning",
    code: "BND001",
    message: "unused binding",
  }] }), "fallback.bend");
  assert.deepEqual(diagnostics, [{
    file: "main.bend",
    line: 3,
    column: 1,
    endLine: 3,
    endColumn: 7,
    code: "BND001",
    message: "unused binding",
    severity: "warning",
  }]);
});

test("preserves the version of the structured diagnostics protocol", () => {
  const result = parseStructuredDiagnosticsDetailed(JSON.stringify({
    protocolVersion: 1,
    diagnostics: [{ file: "main.bend", line: 2, column: 1, category: "proof-goal", message: "open goal", severity: "warning" }],
  }), "fallback.bend");
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.diagnostics[0]?.category, "proof-goal");
});

test("parses JSON-lines diagnostics and related notes", () => {
  const diagnostics = parseStructuredDiagnostics([
    JSON.stringify({ file: "main.bend", line: 2, column: 1, severity: "error", code: "BND002", message: "type mismatch", relatedInformation: [{ file: "lib.bend", start: { line: 7, column: 3 }, message: "type declared here" }] }),
    "compiler progress: checking imports",
    JSON.stringify({ file: "lib.bend", start: { line: 7, column: 3 }, severity: "info", message: "declaration" }),
  ].join("\n"), "fallback.bend");
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0]?.code, "BND002");
  assert.deepEqual(diagnostics[0]?.relatedInformation, [{
    file: "lib.bend",
    line: 6,
    column: 2,
    endLine: 6,
    endColumn: 3,
    message: "type declared here",
  }]);
});

test("normalizes checked-in text and JSON-lines diagnostic fixtures", async () => {
  const fixtureRoot = path.join(process.cwd(), "src", "test", "fixtures");
  const textFixture = await readFile(path.join(fixtureRoot, "compiler-diagnostics.text"), "utf8");
  const jsonFixture = await readFile(path.join(fixtureRoot, "compiler-diagnostics.jsonl"), "utf8");
  const envelopeFixture = await readFile(path.join(fixtureRoot, "compiler-diagnostics.envelope.json"), "utf8");
  const textDiagnostics = parseCompilerDiagnostics(textFixture, "fallback.bend");
  const jsonDiagnostics = parseStructuredDiagnostics(jsonFixture, "fallback.bend");
  const envelopeDiagnostics = parseStructuredDiagnosticsDetailed(envelopeFixture, "fallback.bend");
  assert.equal(textDiagnostics[0]?.line, 3);
  assert.equal(textDiagnostics[1]?.severity, "warning");
  assert.equal(jsonDiagnostics[0]?.expectedType, "Nat");
  assert.equal(jsonDiagnostics[0]?.observedType, "Bool");
  assert.equal(jsonDiagnostics[1]?.relatedInformation?.[0]?.file, "examples/LAWS.bend");
  assert.equal(envelopeDiagnostics.protocolVersion, 1);
  assert.equal(envelopeDiagnostics.diagnostics[0]?.code, "BND-TYPE-001");
  assert.equal(envelopeDiagnostics.diagnostics[0]?.endColumn, 8);
  assert.deepEqual(envelopeDiagnostics.diagnostics[1]?.proofContext, ["x : Nat"]);
});

test("preserves expected and observed types from structured diagnostics", () => {
  const diagnostics = parseStructuredDiagnostics(JSON.stringify({ diagnostics: [{
    file: "main.bend",
    start: { line: 1, column: 1 },
    message: "type mismatch",
    expected: "Nat",
    actual: "Bool",
  }] }), "fallback.bend");
  assert.equal(diagnostics[0]?.expectedType, "Nat");
  assert.equal(diagnostics[0]?.observedType, "Bool");
});

test("preserves structured proof-state categories and context", () => {
  const diagnostics = parseStructuredDiagnostics(JSON.stringify({ diagnostics: [{
    file: "main.bend",
    line: 4,
    column: 2,
    category: "proof_goal",
    context: ["x : Nat", { name: "hypothesis" }],
    dependencies: ["lemma_a"],
    message: "Open goal",
  }] }), "main.bend");
  assert.equal(diagnostics[0]?.category, "proof-goal");
  assert.deepEqual(diagnostics[0]?.proofContext, ["x : Nat", "hypothesis"]);
  assert.deepEqual(diagnostics[0]?.proofDependencies, ["lemma_a"]);
});

test("retains unknown structured diagnostic fields for forward compatibility", () => {
  const diagnostics = parseStructuredDiagnostics(JSON.stringify({ diagnostics: [{
    file: "main.bend",
    line: 2,
    column: 1,
    severity: "error",
    message: "future diagnostic",
    futureGoalId: "goal-42",
    tags: ["compiler", "future"],
    relatedInformation: [{ file: "laws.bend", line: 4, column: 1, message: "law", sourceRevision: "abc123" }],
  }] }), "fallback.bend");
  assert.deepEqual(diagnostics[0]?.extensions, { futureGoalId: "goal-42", tags: ["compiler", "future"] });
  assert.deepEqual(diagnostics[0]?.relatedInformation?.[0]?.extensions, { sourceRevision: "abc123" });
});

test("builds validated runtime arguments for execution profiles", () => {
  assert.deepEqual(runtimeArguments(), []);
  assert.deepEqual(runtimeArguments({ profile: "native", threads: 4 }), ["--threads", "4"]);
  assert.deepEqual(runtimeArguments({ profile: "gpu", threads: 8, gpuMemory: "4GB" }), ["--threads", "8", "--gpu", "4GB"]);
  assert.throws(() => runtimeArguments({ profile: "gpu", gpuMemory: "unlimited" }), /gpuMemory/);
  assert.throws(() => runtimeArguments({ profile: "native", threads: 0 }), /threads/);
});

test("detects documented compiler backend capabilities", () => {
  const info = {
    command: "bend",
    argsPrefix: [],
    source: "path" as const,
    displayPath: "bend",
    version: "2.0.0",
    compatibility: "supported" as const,
    available: true,
    capabilities: parseCompilerCapabilities("Bend runs on the JS backend. Compile to a native binary. Use --threads 8 and --gpu 4GB.", "guide"),
  };
  assert.equal(backendCapability(info, "javascript"), "supported");
  assert.equal(backendCapability(info, "native"), "supported");
  assert.equal(backendCapability(info, "gpu"), "supported");
  assert.equal(info.capabilities?.threads, "supported");
});

test("does not mark explicitly unavailable capabilities as supported", () => {
  const capabilities = parseCompilerCapabilities("JavaScript target supported; native executable supported; GPU backend unavailable; threads are unsupported.", "guide");
  assert.equal(capabilities.javascript, "supported");
  assert.equal(capabilities.native, "supported");
  assert.equal(capabilities.gpu, "unsupported");
  assert.equal(capabilities.threads, "unsupported");
});

test("requires at least two backends for differential execution", async () => {
  const result = await new BendToolchain({ workspaceRoot: process.cwd() }).compareBackends("main.bend", ["native"]);
  assert.equal(result.comparable, false);
  assert.match(result.error ?? "", /at least two/);
});

test("reports an unavailable compiler from an active backend probe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-probe-unavailable-test-"));
  try {
    const result = await new BendToolchain({ workspaceRoot: root, executablePath: path.join(root, "missing-bend") }).probe(path.join(root, "main.bend"), "gpu");
    assert.equal(result.status, "unavailable");
    assert.match(result.message, /Bend 2 was not found|could not run/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates opt-in differential project manifests", () => {
  assert.deepEqual(parseDifferentialManifest({ files: ["main.bend"], profiles: ["javascript", "native"], threads: 4 }), {
    files: ["main.bend"], profiles: ["javascript", "native"], threads: 4,
  });
  assert.throws(() => parseDifferentialManifest({ files: ["../outside.bend"] }), /stay inside/);
  assert.throws(() => parseDifferentialManifest({ files: ["main.bend"], profiles: ["native"] }), /at least two/);
});

test("rejects differential inputs that are missing or not Bend files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-differential-manifest-test-"));
  try {
    await mkdir(path.join(root, ".bend2"));
    await writeFile(path.join(root, ".bend2", "differential.json"), JSON.stringify({ files: ["missing.bend"] }));
    await assert.rejects(loadDifferentialManifest(root), /existing \.bend file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks Bend 2 versions and unknown versions explicitly", () => {
  assert.equal(compilerCompatibility("2.0.21"), "supported");
  assert.equal(compilerCompatibility("3.0.0"), "unsupported");
  assert.equal(compilerCompatibility(null), "unknown");
});

test("explains the Windows host limitation without hiding WSL and remote options", () => {
  assert.match(compilerUnavailableMessage("win32"), /WSL/);
  assert.match(compilerUnavailableMessage("win32"), /Linux\/macOS remote workspace/);
  assert.match(compilerUnavailableMessage("linux"), /executablePath/);
});

test("uses the documented Bend 2 version, guide and file-check commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-cli-contract-test-"));
  try {
    const compiler = process.platform === "win32" ? path.join(root, "fake-bend.cmd") : path.join(root, "fake-bend.sh");
    if (process.platform === "win32") {
      await writeFile(compiler, [
        "@echo off",
        ">>\"%~dp0calls.log\" echo %*",
        "if \"%~1\"==\"bend\" shift",
        "if \"%~1\"==\"--version\" (echo bend 2.0.16& exit /b 0)",
        "if \"%~1\"==\"version\" (echo bend 2.0.16& exit /b 0)",
        "if \"%~1\"==\"guide\" (echo JavaScript target native executable --threads --gpu& exit /b 0)",
        "if \"%~1\"==\"--help\" (echo Bend help& exit /b 0)",
        "echo %~1:2:3: error: type mismatch 1>&2",
        "exit /b 1",
        "",
      ].join("\r\n"));
    } else {
      await writeFile(compiler, [
        "#!/usr/bin/env bash",
        "set -eu",
        "printf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/calls.log\"",
        "if [ \"${1:-}\" = bend ]; then shift; fi",
        "case \"$1\" in",
        "  --version|version) echo 'bend 2.0.16' ;;",
        "  guide) echo 'JavaScript target native executable --threads --gpu' ;;",
        "  --help) echo 'Bend help' ;;",
        "  *) echo \"$1:2:3: error: type mismatch\" >&2; exit 1 ;;",
        "esac",
        "",
      ].join("\n"));
      await chmod(compiler, 0o755);
    }
    const file = path.join(root, "main.bend");
    await writeFile(file, "def main():\n  0\n");
    const adapter = new BendToolchain({ workspaceRoot: root, executablePath: compiler, executableArgs: ["bend"] });
    const info = await adapter.discover();
    assert.equal(info.version, "2.0.16");
    assert.equal(info.compatibility, "supported");
    const result = await adapter.check(file);
    assert.equal(result.code, 1);
    assert.equal(result.diagnosticTransport, "text");
    assert.equal(result.diagnostics[0]?.file, file);
    assert.equal(result.diagnostics[0]?.message, "type mismatch");
    const calls = await readFile(path.join(root, "calls.log"), "utf8");
    assert.match(calls, /--version/);
    assert.match(calls, /bend --version/);
    assert.match(calls, /guide/);
    assert.match(calls, /main\.bend/);
    assert.match(calls, /main\.bend --check-only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps configured launcher arguments before Bend commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-launcher-args-test-"));
  try {
    const script = [
      "const args = process.argv.slice(1);",
      "const command = args.at(-1);",
      "if (command === '--version' || command === 'version') console.log('bend 2.0.16');",
      "else if (command === 'guide') console.log('JavaScript target native executable --threads');",
      "else console.log('ok');",
    ].join(" ");
    const adapter = new BendToolchain({ workspaceRoot: root, executablePath: process.execPath, executableArgs: ["--no-warnings", "-e", script, "--"] });
    const info = await adapter.discover();
    assert.equal(info.source, "configured");
    assert.equal(info.version, "2.0.16");
    assert.deepEqual(info.argsPrefix, ["--no-warnings", "-e", script, "--"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves launcher prefixes for WSL, SSH, Dev Container and Codespaces fixtures", async () => {
  const fixturePath = path.join(process.cwd(), "src", "test", "fixtures", "remote-launchers.json");
  const fixtures = JSON.parse(await readFile(fixturePath, "utf8")) as Array<{ name: string; arguments: string[] }>;
  const script = [
    "const args = process.argv.slice(1);",
    "const command = args.at(-1);",
    "if (command === '--version' || command === 'version') console.log('bend 2.0.16');",
    "else if (command === 'guide') console.log('JavaScript target native executable --threads');",
    "else console.log('ok');",
  ].join(" ");

  for (const fixture of fixtures) {
    const root = await mkdtemp(path.join(os.tmpdir(), "bend2-remote-launcher-"));
    try {
      const adapter = new BendToolchain({
        workspaceRoot: root,
        executablePath: process.execPath,
        executableArgs: ["--no-warnings", "-e", script, "--", ...fixture.arguments],
      });
      const info = await adapter.discover();
      assert.equal(info.source, "configured", fixture.name);
      assert.equal(info.version, "2.0.16", fixture.name);
      assert.deepEqual(info.argsPrefix.slice(-fixture.arguments.length), fixture.arguments, fixture.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("falls back when an older Bend launcher rejects check-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-check-only-fallback-test-"));
  try {
    const script = [
      "const args = process.argv.slice(1);",
      "const command = args.at(-1);",
      "if (command === '--version' || command === 'version') console.log('bend 2.0.16');",
      "else if (command === 'guide') console.log('JavaScript target native executable --threads');",
      "else if (args.includes('--check-only')) { console.error('unknown option --check-only'); process.exitCode = 2; }",
      "else { console.error('main.bend:2:3: error: legacy check'); process.exitCode = 1; }",
    ].join(" ");
    const file = path.join(root, "main.bend");
    await writeFile(file, "law legacy_check:\n  ?TODO\n");
    const adapter = new BendToolchain({ workspaceRoot: root, executablePath: process.execPath, executableArgs: ["--no-warnings", "-e", script, "--"] });
    const result = await adapter.check(file);
    assert.equal(result.code, 1);
    assert.equal(result.diagnostics[0]?.message, "legacy check");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to execute main when a legacy launcher lacks check-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-check-only-safety-test-"));
  try {
    const script = [
      "const args = process.argv.slice(1);",
      "const command = args.at(-1);",
      "if (command === '--version' || command === 'version') console.log('bend 2.0.16');",
      "else if (command === 'guide') console.log('JavaScript target native executable --threads');",
      "else if (args.includes('--check-only')) { console.error('unknown option --check-only'); process.exitCode = 2; }",
      "else { console.log('main executed'); }",
    ].join(" ");
    const file = path.join(root, "main.bend");
    await writeFile(file, "def main():\n  0\n");
    const adapter = new BendToolchain({ workspaceRoot: root, executablePath: process.execPath, executableArgs: ["--no-warnings", "-e", script, "--"] });
    const result = await adapter.check(file);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /stopped to avoid executing main\(\)/);
    assert.doesNotMatch(result.stdout, /main executed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a missing project gate without invoking a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-gate-test-"));
  try {
    const result = await new BendToolchain({ workspaceRoot: root }).runGate("check");
    assert.equal(result.code, null);
    assert.match(result.stderr, /check gate was not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects project gate targets outside the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-gate-target-test-"));
  try {
    const result = await new BendToolchain({ workspaceRoot: root }).runGate("check", path.join("..", "outside"));
    assert.equal(result.code, null);
    assert.match(result.stderr, /must stay inside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers and executes a project gate with a relative target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bend2-gate-run-test-"));
  try {
    const scripts = path.join(root, "scripts");
    await mkdir(scripts);
    if (process.platform === "win32") {
      await writeFile(path.join(scripts, "check.cmd"), "@echo off\necho gate-target=%1\necho project/main.bend:2:3: error: gate issue\nexit /b 0\n");
    } else {
      const script = path.join(scripts, "check.sh");
      await writeFile(script, "#!/usr/bin/env bash\necho gate-target=$1\necho project/main.bend:2:3: error: gate issue\n");
      await chmod(script, 0o755);
    }
    const result = await new BendToolchain({ workspaceRoot: root }).runGate("check", "project");
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /gate-target=project/);
    assert.equal(result.diagnostics[0]?.file, "project/main.bend");
    assert.equal(result.diagnostics[0]?.line, 1);
    assert.equal(result.diagnostics[0]?.column, 2);
    assert.equal(result.diagnostics[0]?.message, "gate issue");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
