import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { BackendProfile, BendToolchain, CompilerDiagnostic, DiagnosticsMode, GateKind, backendCapability, cancelToolchainProcesses, loadDifferentialManifest } from "@bend2/toolchain";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { openLaw, ProofExplorer, showProofDetails, showProofGoal } from "./proofExplorer";
import { registerProofTests } from "./testExplorer";
import { benchmarkSpeedup } from "./benchmarkPresentation";
import { compilerStatusAccessibilityLabel } from "./accessibilityLabels.js";

let client: LanguageClient | undefined;
let compilerStatus: vscode.StatusBarItem | undefined;
let compilerProblems: vscode.DiagnosticCollection | undefined;
const execFileAsync = promisify(execFile);

function executable(): string {
  return vscode.workspace.getConfiguration("bend2").get<string>("executablePath", "bend");
}

function activeBendDocument(): vscode.TextDocument | undefined {
  const document = vscode.window.activeTextEditor?.document;
  return document?.languageId === "bend" ? document : undefined;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toolchain(): BendToolchain | undefined {
  const root = workspaceRoot();
  const settings = vscode.workspace.getConfiguration("bend2");
  return root ? new BendToolchain({
    workspaceRoot: root,
    executablePath: executable(),
    executableArgs: settings.get<string[]>("executableArgs", []),
    diagnosticsMode: settings.get<DiagnosticsMode>("diagnosticsMode", "auto"),
  }) : undefined;
}

function compilerDiagnosticMessage(diagnostic: CompilerDiagnostic): string {
  const details = [
    diagnostic.expectedType ? `Expected: ${diagnostic.expectedType}` : "",
    diagnostic.observedType ? `Observed: ${diagnostic.observedType}` : "",
  ].filter(Boolean);
  return details.length > 0 ? `${diagnostic.message}\n${details.join("\n")}` : diagnostic.message;
}

function compilerDiagnosticSeverity(severity: CompilerDiagnostic["severity"]): vscode.DiagnosticSeverity {
  if (severity === "error") return vscode.DiagnosticSeverity.Error;
  if (severity === "warning") return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

function compilerDiagnosticUri(file: string, fallbackFile: string): vscode.Uri {
  const candidate = file || fallbackFile;
  return vscode.Uri.file(path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot() ?? path.dirname(fallbackFile), candidate));
}

function publishCommandDiagnostics(results: Array<{ fallbackFile: string; diagnostics: CompilerDiagnostic[] }>): void {
  compilerProblems?.clear();
  if (!compilerProblems) return;
  const grouped = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
  for (const result of results) {
    for (const item of result.diagnostics) {
      const uri = compilerDiagnosticUri(item.file, result.fallbackFile);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
          item.line,
          item.column,
          item.endLine ?? item.line,
          item.endColumn ?? item.column + 1,
        ),
        compilerDiagnosticMessage(item),
        compilerDiagnosticSeverity(item.severity),
      );
      diagnostic.source = "Bend 2 compiler";
      diagnostic.code = item.code ?? item.category;
      diagnostic.relatedInformation = item.relatedInformation?.map((related) => new vscode.DiagnosticRelatedInformation(
        new vscode.Location(
          compilerDiagnosticUri(related.file, result.fallbackFile),
          new vscode.Range(
            related.line,
            related.column,
            related.endLine ?? related.line,
            related.endColumn ?? related.column + 1,
          ),
        ),
        related.message,
      ));
      const entry = grouped.get(uri.toString()) ?? { uri, diagnostics: [] };
      entry.diagnostics.push(diagnostic);
      grouped.set(uri.toString(), entry);
    }
  }
  for (const entry of grouped.values()) compilerProblems.set(entry.uri, entry.diagnostics);
}

async function verifyBackend(adapter: BendToolchain, profile: BackendProfile): Promise<boolean> {
  const compiler = await adapter.discover();
  const capability = backendCapability(compiler, profile);
  if (capability === "unsupported") {
    vscode.window.showErrorMessage(`The active Bend compiler does not advertise the ${profile} backend.`);
    return false;
  }
  if (capability === "unknown") {
    vscode.window.showWarningMessage(`The active Bend compiler did not expose capability metadata for the ${profile} backend; the command will continue and let the compiler decide.`);
  }
  return true;
}

async function checkFile(): Promise<void> {
  const document = activeBendDocument();
  if (!document) {
    vscode.window.showInformationMessage("Open a Bend 2 file first.");
    return;
  }
  const adapter = toolchain();
  if (!adapter) return;
  const output = vscode.window.createOutputChannel("Bend 2");
  output.show(true);
  const result = await adapter.check(document.uri.fsPath);
  output.appendLine(`Bend check: ${result.code === 0 ? "PASS" : "FAIL"}`);
  if (result.stdout) output.append(result.stdout);
  if (result.stderr) output.append(result.stderr);
  for (const diagnostic of result.diagnostics) output.appendLine(`${diagnostic.file}:${diagnostic.line + 1}:${diagnostic.column + 1}: ${diagnostic.severity}: ${diagnostic.message}`);
  publishCommandDiagnostics([{ fallbackFile: document.uri.fsPath, diagnostics: result.diagnostics }]);
}

async function checkProof(uri: string, lawName: string): Promise<boolean> {
  const lawUri = vscode.Uri.parse(uri);
  const proofFile = vscode.Uri.file(path.join(path.dirname(lawUri.fsPath), "PROOF.bend"));
  const adapter = toolchain();
  if (!adapter) return false;
  const output = vscode.window.createOutputChannel("Bend 2 Proof Check");
  output.show(true);
  const result = await adapter.check(proofFile.fsPath);
  output.appendLine(`Proof check: ${lawName} — ${result.code === 0 ? "PASS" : "FAIL"}`);
  if (result.stdout) output.append(result.stdout);
  if (result.stderr) output.append(result.stderr);
  for (const diagnostic of result.diagnostics) {
    output.appendLine(`${diagnostic.file}:${diagnostic.line + 1}:${diagnostic.column + 1}: ${diagnostic.severity}: ${diagnostic.message}`);
  }
  publishCommandDiagnostics([{ fallbackFile: proofFile.fsPath, diagnostics: result.diagnostics }]);
  if (result.code === 0) vscode.window.showInformationMessage(`Proof '${lawName}' passed.`);
  else vscode.window.showWarningMessage(`Proof '${lawName}' failed or could not be checked.`);
  return result.code === 0;
}

async function reviewLawChanges(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showInformationMessage("Open a Bend 2 workspace first.");
    return;
  }
  const files = await vscode.workspace.findFiles("**/LAWS.bend", "**/node_modules/**");
  if (files.length === 0) {
    vscode.window.showInformationMessage("No LAWS.bend files were found in this workspace.");
    return;
  }
  const selected = files.length === 1
    ? files[0]
    : await vscode.window.showQuickPick(files.map((file) => ({ label: vscode.workspace.asRelativePath(file), file })), { title: "Bend 2 law review", placeHolder: "Choose a LAWS.bend file to compare with HEAD" }).then((choice) => choice?.file);
  if (!selected) return;
  const relative = path.relative(root, selected.fsPath);
  const output = vscode.window.createOutputChannel("Bend 2 Law Review");
  output.show(true);
  try {
    const result = await execFileAsync("git", ["-C", root, "diff", "--no-ext-diff", "--unified=80", "HEAD", "--", relative], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    if (!result.stdout.trim()) {
      output.appendLine(`${relative}: no changes relative to HEAD.`);
      vscode.window.showInformationMessage(`${relative} has no changes relative to HEAD.`);
      return;
    }
    output.appendLine(`Review diff for ${relative} before accepting law changes:\n`);
    output.append(result.stdout);
    if (result.stderr) output.append(`\n${result.stderr}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Could not review ${relative}: ${message}`);
    vscode.window.showErrorMessage(`Could not review law changes: ${message}`);
  }
}

async function checkWorkspace(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showInformationMessage("Open a Bend 2 workspace first.");
    return;
  }
  const files = await vscode.workspace.findFiles("**/PROOF.bend", "**/node_modules/**");
  if (files.length === 0) {
    vscode.window.showInformationMessage("No PROOF.bend files were found in this workspace.");
    return;
  }
  const output = vscode.window.createOutputChannel("Bend 2 Gate");
  output.show(true);
  const adapter = toolchain();
  if (!adapter) return;
  const results: Array<{ fallbackFile: string; diagnostics: CompilerDiagnostic[] }> = [];
  for (const file of files) {
    output.appendLine(`Checking ${vscode.workspace.asRelativePath(file)}...`);
    const result = await adapter.check(file.fsPath);
    if (result.stdout) output.append(result.stdout);
    if (result.stderr) output.append(result.stderr);
    output.appendLine(`Result: ${result.code === 0 ? "PASS" : "FAIL"}\n`);
    results.push({ fallbackFile: file.fsPath, diagnostics: result.diagnostics });
  }
  publishCommandDiagnostics(results);
}

async function runGate(kind: GateKind): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showInformationMessage("Open a Bend 2 workspace first.");
    return;
  }
  const target = await vscode.window.showInputBox({
    title: `Bend 2 ${kind} gate target`,
    prompt: "Optional project directory relative to the workspace; leave empty for the script default",
    placeHolder: "projetos/passagens-core",
  });
  if (target === undefined) return;
  const adapter = toolchain();
  if (!adapter) return;
  const output = vscode.window.createOutputChannel(`Bend 2 ${kind} Gate`);
  output.show(true);
  const controller = new AbortController();
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running Bend 2 ${kind} gate`, cancellable: true }, async (_progress, token) => {
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      return await adapter.runGate(kind, target.trim() || undefined, controller.signal);
    } finally {
      cancellation.dispose();
    }
  });
  if (result.stdout) output.append(result.stdout);
  if (result.stderr) output.append(result.stderr);
  output.appendLine(`\nBend 2 ${kind} gate ${result.code === 0 ? "passed" : result.cancelled ? "cancelled" : "failed"}.`);
  publishCommandDiagnostics([{ fallbackFile: root, diagnostics: result.diagnostics }]);
}

async function buildFile(): Promise<void> {
  const document = activeBendDocument();
  if (!document) {
    vscode.window.showInformationMessage("Open a Bend 2 file first.");
    return;
  }
  const profile = await vscode.window.showQuickPick([
    { label: "JavaScript source", description: "Emit a JavaScript file for the sequential backend.", profile: "javascript" as BackendProfile },
    { label: "Native executable", description: "Compile a native CPU executable.", profile: "native" as BackendProfile },
    { label: "Native executable (GPU-capable)", description: "Compile a native executable that can be run with GPU memory enabled.", profile: "gpu" as BackendProfile },
  ], { title: "Bend 2 build profile", placeHolder: "Choose the output backend" });
  if (!profile) return;
  const adapter = toolchain();
  if (!adapter) return;
  if (!await verifyBackend(adapter, profile.profile)) return;
  const suffix = profile.profile === "javascript" ? ".js" : process.platform === "win32" ? ".exe" : "";
  const defaultOutput = path.join(path.dirname(document.uri.fsPath), `${path.basename(document.uri.fsPath, ".bend")}${suffix}`);
  const outputPath = await vscode.window.showInputBox({
    title: "Bend 2 build output",
    prompt: "Output binary or generated source path",
    value: defaultOutput,
  });
  if (!outputPath) return;
  const resolvedOutput = path.isAbsolute(outputPath) ? outputPath : path.resolve(path.dirname(document.uri.fsPath), outputPath);
  const output = vscode.window.createOutputChannel("Bend 2 Build");
  output.show(true);
  const result = await adapter.build(document.uri.fsPath, resolvedOutput, { profile: profile.profile });
  if (result.stdout) output.append(result.stdout);
  if (result.stderr) output.append(result.stderr);
  output.appendLine(`\nBend ${profile.label} build ${result.code === 0 ? "succeeded" : "failed"}: ${resolvedOutput}`);
}

async function runFile(): Promise<void> {
  const document = activeBendDocument();
  if (!document) {
    vscode.window.showInformationMessage("Open a Bend 2 file first.");
    return;
  }
  const adapter = toolchain();
  if (!adapter) return;
  const profile = await vscode.window.showQuickPick([
    { label: "JavaScript", description: "Run through the compiler's sequential JavaScript backend.", profile: "javascript" as BackendProfile },
    { label: "Native CPU", description: "Compile and run a native executable.", profile: "native" as BackendProfile },
    { label: "GPU", description: "Compile a native executable and run it with GPU execution enabled.", profile: "gpu" as BackendProfile },
  ], { title: "Bend 2 run profile", placeHolder: "Choose the execution backend" });
  if (!profile) return;
  if (!await verifyBackend(adapter, profile.profile)) return;
  let threads: number | undefined;
  let gpuMemory: string | undefined;
  if (profile.profile !== "javascript") {
    const threadsText = await vscode.window.showInputBox({
      title: "Bend 2 runtime threads",
      prompt: "Optional positive CPU thread count; leave empty for the runtime default",
      validateInput: (value) => value === "" || /^\d+$/.test(value) && Number(value) > 0 ? undefined : "Enter a positive integer or leave this empty.",
    });
    if (threadsText === undefined) return;
    threads = threadsText ? Number(threadsText) : undefined;
  }
  if (profile.profile === "gpu") {
    gpuMemory = await vscode.window.showInputBox({
      title: "Bend 2 GPU memory",
      prompt: "Use 'on' or a limit such as '4GB'.",
      value: "on",
      validateInput: (value) => /^(?:on|\d+(?:\.\d+)?(?:KB|MB|GB|TB))$/i.test(value) ? undefined : "Use 'on' or a memory limit such as '4GB'.",
    });
    if (!gpuMemory) return;
  }
  const output = vscode.window.createOutputChannel("Bend 2 Run");
  output.show(true);
  const result = await adapter.run(document.uri.fsPath, { profile: profile.profile, threads, gpuMemory });
  if (result.stdout) output.append(result.stdout);
  if (result.stderr) output.append(result.stderr);
  output.appendLine(`\nBend ${profile.label} run exited with code ${result.code ?? "unknown"}.`);
}

async function probeBackend(): Promise<void> {
  const document = activeBendDocument();
  if (!document) {
    vscode.window.showInformationMessage("Open a Bend 2 file first.");
    return;
  }
  const profile = await vscode.window.showQuickPick([
    { label: "JavaScript", description: "Check compiler acceptance without executing the program.", profile: "javascript" as BackendProfile },
    { label: "Native CPU", description: "Compile the current file without running it.", profile: "native" as BackendProfile },
    { label: "GPU (active device)", description: "Compile and execute with --gpu on to test the active device.", profile: "gpu" as BackendProfile },
  ], { title: "Bend 2 backend probe", placeHolder: "Choose the backend to probe" });
  if (!profile) return;
  if (profile.profile === "gpu") {
    const confirmation = await vscode.window.showWarningMessage(
      "The GPU probe executes the current Bend program with --gpu on. Continue?",
      { modal: true },
      "Run GPU Probe",
    );
    if (confirmation !== "Run GPU Probe") return;
  }
  const adapter = toolchain();
  if (!adapter) return;
  const output = vscode.window.createOutputChannel("Bend 2 Backend Probe");
  output.show(true);
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Probing ${profile.label}`, cancellable: true }, async (_progress, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      return await adapter.probe(document.uri.fsPath, profile.profile, controller.signal);
    } finally {
      cancellation.dispose();
    }
  });
  output.appendLine(`Bend 2 ${profile.label} probe: ${result.status.toUpperCase()}`);
  output.appendLine(result.message);
  if (result.check?.stdout) output.append(result.check.stdout);
  if (result.check?.stderr) output.append(result.check.stderr);
  if (result.build?.stdout) output.append(result.build.stdout);
  if (result.build?.stderr) output.append(result.build.stderr);
  if (result.execute?.stdout) output.append(result.execute.stdout);
  if (result.execute?.stderr) output.append(result.execute.stderr);
  if (result.status === "ready") vscode.window.showInformationMessage(`${profile.label} probe passed.`);
  else if (result.status === "cancelled") vscode.window.showInformationMessage(`${profile.label} probe cancelled.`);
  else vscode.window.showWarningMessage(`${profile.label} probe did not pass: ${result.message}`);
}

async function compareBackends(): Promise<void> {
  const document = activeBendDocument();
  if (!document) {
    vscode.window.showInformationMessage("Open a Bend 2 file first.");
    return;
  }
  const choices = [
    { label: "JavaScript", description: "Sequential compiler backend.", profile: "javascript" as BackendProfile },
    { label: "Native CPU", description: "Compiled native executable.", profile: "native" as BackendProfile },
    { label: "GPU", description: "Native executable with GPU execution enabled.", profile: "gpu" as BackendProfile },
  ];
  const selected = await vscode.window.showQuickPick(choices, { title: "Bend 2 differential backends", placeHolder: "Select at least two backends", canPickMany: true });
  if (!selected || selected.length < 2) {
    if (selected) vscode.window.showWarningMessage("Select at least two backends to compare.");
    return;
  }
  const adapter = toolchain();
  if (!adapter) return;
  for (const choice of selected) {
    if (!await verifyBackend(adapter, choice.profile)) return;
  }
  let threads: number | undefined;
  let gpuMemory: string | undefined;
  if (selected.some((choice) => choice.profile !== "javascript")) {
    const threadsText = await vscode.window.showInputBox({
      title: "Bend 2 differential thread count",
      prompt: "Optional positive CPU thread count; leave empty for the runtime default",
      validateInput: (value) => value === "" || /^\d+$/.test(value) && Number(value) > 0 ? undefined : "Enter a positive integer or leave this empty.",
    });
    if (threadsText === undefined) return;
    threads = threadsText ? Number(threadsText) : undefined;
  }
  if (selected.some((choice) => choice.profile === "gpu")) {
    gpuMemory = await vscode.window.showInputBox({
      title: "Bend 2 differential GPU memory",
      prompt: "Use 'on' or a limit such as '4GB'.",
      value: "on",
      validateInput: (value) => /^(?:on|\d+(?:\.\d+)?(?:KB|MB|GB|TB))$/i.test(value) ? undefined : "Use 'on' or a memory limit such as '4GB'.",
    });
    if (!gpuMemory) return;
  }
  const output = vscode.window.createOutputChannel("Bend 2 Differential Backends");
  output.show(true);
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Comparing Bend 2 backends", cancellable: true }, async (_progress, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      return await adapter.compareBackends(document.uri.fsPath, selected.map((choice) => choice.profile), { threads, gpuMemory, signal: controller.signal });
    } finally {
      cancellation.dispose();
    }
  });
  output.appendLine(`Bend 2 differential run: ${vscode.workspace.asRelativePath(document.uri)}`);
  for (const run of result.runs) {
    output.appendLine(`${run.profile}: exit=${run.result.code ?? "unknown"}, sha1=${run.outputSha1 ?? "unavailable"}`);
    if (run.result.stderr) output.appendLine(`  ${run.result.stderr.trim()}`);
  }
  output.appendLine(`Comparable: ${result.comparable ? "yes" : "no"}`);
  output.appendLine(`Outputs match: ${result.outputsMatch ? "yes" : "no"}`);
  if (result.error) output.appendLine(`Result: ${result.error}`);
  if (result.comparable && result.outputsMatch) vscode.window.showInformationMessage("Bend 2 backends produced matching output.");
  else vscode.window.showWarningMessage(result.error ?? "Bend 2 backend comparison was inconclusive.");
}

async function compareProjectBackends(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showInformationMessage("Open a Bend 2 workspace first.");
    return;
  }
  let manifest;
  try {
    manifest = await loadDifferentialManifest(root);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return;
  }
  const adapter = toolchain();
  if (!adapter) return;
  for (const profile of manifest.profiles) {
    if (!await verifyBackend(adapter, profile)) return;
  }
  const files = manifest.files.map((file) => path.resolve(root, file));
  const output = vscode.window.createOutputChannel("Bend 2 Differential Project");
  output.show(true);
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Comparing Bend 2 project backends", cancellable: true }, async (_progress, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      return await adapter.compareProject(files, manifest.profiles, { threads: manifest.threads, gpuMemory: manifest.gpuMemory, signal: controller.signal });
    } finally {
      cancellation.dispose();
    }
  });
  for (const run of result.runs) {
    output.appendLine(`File: ${vscode.workspace.asRelativePath(run.file)}`);
    for (const backend of run.result.runs) output.appendLine(`  ${backend.profile}: exit=${backend.result.code ?? "unknown"}, sha1=${backend.outputSha1 ?? "unavailable"}`);
    output.appendLine(`  Outputs match: ${run.result.outputsMatch ? "yes" : "no"}`);
  }
  output.appendLine(`Comparable: ${result.comparable ? "yes" : "no"}`);
  output.appendLine(`All outputs match: ${result.outputsMatch ? "yes" : "no"}`);
  if (result.error) output.appendLine(`Result: ${result.error}`);
  if (result.comparable && result.outputsMatch) vscode.window.showInformationMessage("Bend 2 project backends produced matching output.");
  else vscode.window.showWarningMessage(result.error ?? "Bend 2 project backend comparison was inconclusive.");
}

async function showBase(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Bend 2 Base lookup",
    prompt: "Optional Base definition name; leave empty to show the Base index",
    placeHolder: "Map",
  });
  if (name === undefined) return;
  const adapter = toolchain();
  if (!adapter) return;
  const output = vscode.window.createOutputChannel("Bend 2 Base");
  output.show(true);
  const result = await adapter.base(name.trim() || undefined);
  if (result.stdout) output.append(result.stdout);
  if (result.stderr) output.append(result.stderr);
  output.appendLine(`\nBend Base lookup exited with code ${result.code ?? "unknown"}.`);
}

async function benchmarkFile(): Promise<void> {
  const document = activeBendDocument();
  if (!document) {
    vscode.window.showInformationMessage("Open a Bend 2 file first.");
    return;
  }
  const threadsText = await vscode.window.showInputBox({
    title: "Bend 2 benchmark threads",
    prompt: "Runtime thread counts, comma-separated for a speedup curve",
    value: "1,2,4",
    validateInput: (value) => /^\d+(,\d+)*$/.test(value) && value.split(",").every((item) => Number(item) > 0) ? undefined : "Enter positive integers separated by commas.",
  });
  if (!threadsText) return;
  const runsText = await vscode.window.showInputBox({
    title: "Bend 2 benchmark repetitions",
    prompt: "Measured runs (one warm-up is discarded)",
    value: "3",
    validateInput: (value) => /^\d+$/.test(value) && Number(value) > 0 ? undefined : "Enter a positive integer.",
  });
  if (!runsText) return;
  const gpu = await vscode.window.showQuickPick(["off", "on", "4GB"], { title: "Bend 2 GPU mode", placeHolder: "Choose the runtime GPU mode or memory limit" });
  if (!gpu) return;
  const adapter = toolchain();
  if (!adapter) return;
  const output = vscode.window.createOutputChannel("Bend 2 Benchmarks");
  output.show(true);
  const controller = new AbortController();
  const threadCounts = [...new Set(threadsText.split(",").map((item) => Number(item)))];
  const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Benchmarking Bend 2", cancellable: true }, async (progress, token) => {
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      const values = [];
      for (let index = 0; index < threadCounts.length; index += 1) {
        progress.report({ message: `threads=${threadCounts[index]} (${index + 1}/${threadCounts.length})`, increment: 100 / threadCounts.length });
        values.push(await adapter.benchmark(document.uri.fsPath, { threads: threadCounts[index], runs: Number(runsText), gpu, signal: controller.signal }));
        if (controller.signal.aborted) break;
      }
      return values;
    } finally {
      cancellation.dispose();
    }
  });
  output.appendLine(`Bend 2 benchmark: ${vscode.workspace.asRelativePath(document.uri)}`);
  const baseline = results.find((result) => result.ok && result.medianMs !== null);
  output.appendLine(`GPU=${gpu}, warmup=${baseline?.warmup ?? true}, runs=${Number(runsText)}`);
  for (const result of results) {
    output.appendLine(`threads=${result.threads ?? "default"}: compiler=${result.compiler.version ?? "unknown"}${result.compiler.revision ? ` (${result.compiler.revision})` : ""}`);
    output.appendLine(`  Machine: ${result.machine.platform}/${result.machine.arch}, CPUs=${result.machine.cpuCount}`);
    if (!result.ok) {
      output.appendLine(`  Failed: ${(result.error ?? result.compile.stderr) || "unknown error"}`);
      continue;
    }
    const speedup = benchmarkSpeedup(baseline, result);
    output.appendLine(`  Samples (ms): ${result.samplesMs.map((sample) => sample.toFixed(3)).join(", ")}`);
    output.appendLine(`  Median: ${result.medianMs?.toFixed(3)} ms; range=${result.minMs?.toFixed(3)}–${result.maxMs?.toFixed(3)} ms`);
    output.appendLine(`  Output stable: ${result.outputsMatch ? "yes" : "no"}${result.outputSha1 ? ` (sha1 ${result.outputSha1})` : ""}`);
    output.appendLine(`  Speedup vs first comparable configuration: ${speedup ? `${speedup.toFixed(2)}x` : "not reported"}`);
    if (!result.outputsMatch) output.appendLine("  WARNING: measured runs produced different stdout; performance comparison is suppressed.");
  }
  const saveReport = await vscode.window.showQuickPick(["Save JSON report", "Keep in Output only"], {
    title: "Bend 2 benchmark report",
    placeHolder: "Persist measured metadata for later comparison",
  });
  if (saveReport !== "Save JSON report") return;
  const root = workspaceRoot();
  if (!root) return;
  const defaultUri = vscode.Uri.file(path.join(root, ".bend", "benchmarks", `bend2-${Date.now()}.json`));
  const destination = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { "JSON": ["json"] },
    saveLabel: "Save benchmark report",
  });
  if (!destination) return;
  const reportBaseline = results.find((result) => result.ok && result.medianMs !== null);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    file: vscode.workspace.asRelativePath(document.uri),
    requestedThreads: threadCounts,
    gpu,
    runs: Number(runsText),
    results: results.map((result) => ({
      ok: result.ok,
      compiler: {
        version: result.compiler.version,
        revision: result.compiler.revision ?? null,
        compatibility: result.compiler.compatibility,
        source: result.compiler.source,
      },
      machine: result.machine,
      warmup: result.warmup,
      threads: result.threads,
      samplesMs: result.samplesMs,
      medianMs: result.medianMs,
      minMs: result.minMs,
      maxMs: result.maxMs,
      outputsMatch: result.outputsMatch,
      outputSha1: result.outputSha1,
      speedupVsFirstComparable: benchmarkSpeedup(reportBaseline, result),
      error: result.error ?? null,
    })),
  };
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination.fsPath)));
    await vscode.workspace.fs.writeFile(destination, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"));
    output.appendLine(`\nSaved benchmark report: ${vscode.workspace.asRelativePath(destination)}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not save benchmark report: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function openProof(uri: string, lawName: string): Promise<void> {
  const source = vscode.Uri.parse(uri);
  const proofFile = vscode.Uri.file(path.join(path.dirname(source.fsPath), "PROOF.bend"));
  try {
    const content = (await vscode.workspace.fs.readFile(proofFile)).toString();
    const escaped = lawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declaration = new RegExp(`^\\s*def\\s+(?:Laws\\.)?${escaped}(?=\\s|\\(|:)`);
    const lines = content.split(/\r?\n/);
    const line = lines.findIndex((value) => declaration.test(value));
    if (line >= 0) {
      const document = await vscode.workspace.openTextDocument(proofFile);
      const editor = await vscode.window.showTextDocument(document);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      return;
    }
  } catch {
    // A project may not have a proof file yet.
  }
  await vscode.window.showTextDocument(source);
  vscode.window.showInformationMessage(`No proof definition for '${lawName}' was found.`);
}

async function showVersion(): Promise<void> {
  const adapter = toolchain();
  if (!adapter) {
    vscode.window.showInformationMessage("Open a Bend 2 workspace first.");
    return;
  }
  const info = await adapter.discover();
  if (info.available) {
    const qualifier = info.compatibility === "unsupported" ? "unsupported" : info.compatibility === "unknown" ? "unverified" : "supported";
    const message = `Bend ${info.version ?? "version unknown"} (${qualifier}) — ${info.displayPath}`;
    if (info.compatibility === "unsupported") vscode.window.showWarningMessage(message);
    else vscode.window.showInformationMessage(message);
    if (compilerStatus) compilerStatus.text = `${info.compatibility === "unsupported" ? "$(warning)" : "$(check)"} Bend ${info.version ?? "unknown"}`;
  } else {
    vscode.window.showErrorMessage(info.error ?? "Bend 2 was not found.");
    if (compilerStatus) compilerStatus.text = "$(error) Bend unavailable";
  }
}

async function showExecutionEnvironment(): Promise<void> {
  const adapter = toolchain();
  if (!adapter) {
    vscode.window.showInformationMessage("Open a Bend 2 workspace first.");
    return;
  }
  const settings = vscode.workspace.getConfiguration("bend2");
  const info = await adapter.discover();
  const output = vscode.window.createOutputChannel("Bend 2 Execution Environment");
  output.show(true);
  output.appendLine("Bend 2 execution environment");
  output.appendLine(`Extension host platform: ${process.platform}/${process.arch}`);
  output.appendLine(`VS Code remote: ${vscode.env.remoteName ?? "local"}`);
  output.appendLine(`VS Code UI: ${vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop"}`);
  output.appendLine(`Compiler available: ${info.available ? "yes" : "no"}`);
  output.appendLine(`Compiler host platform: ${process.platform}`);
  output.appendLine(`Discovery source: ${info.source}`);
  output.appendLine(`Compiler display path: ${info.displayPath}`);
  output.appendLine(`Launcher command: ${info.command}`);
  output.appendLine(`Launcher prefix: ${JSON.stringify(info.argsPrefix)}`);
  output.appendLine(`Configured executable: ${settings.get<string>("executablePath", "bend")}`);
  output.appendLine(`Configured launcher arguments: ${JSON.stringify(settings.get<string[]>("executableArgs", []))}`);
  output.appendLine(`Compiler version: ${info.version ?? "unknown"}`);
  output.appendLine(`Compatibility: ${info.compatibility}`);
  if (info.capabilities) output.appendLine(`Capabilities: ${JSON.stringify(info.capabilities)}`);
  if (info.error) output.appendLine(`Error: ${info.error}`);
}

async function copySupportDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const settings = vscode.workspace.getConfiguration("bend2");
  const adapter = toolchain();
  const compiler = adapter ? await adapter.discover() : undefined;
  const report = {
    schemaVersion: 1,
    extension: { version: String(context.extension.packageJSON.version ?? "unknown") },
    vscode: { version: vscode.version, remoteName: vscode.env.remoteName ?? null, uiKind: vscode.env.uiKind },
    runtime: { platform: process.platform, arch: process.arch, node: process.version },
    workspace: { folderCount: vscode.workspace.workspaceFolders?.length ?? 0, hasWorkspace: Boolean(workspaceRoot()) },
    compiler: compiler ? {
      available: compiler.available,
      version: compiler.version,
      revision: compiler.revision ?? null,
      compatibility: compiler.compatibility,
      source: compiler.source,
    } : null,
    settings: {
      validationMode: settings.get<string>("validationMode", "onSave"),
      diagnosticsMode: settings.get<string>("diagnosticsMode", "auto"),
      autoImport: settings.get<boolean>("autoImport", false),
      formatterMode: settings.get<string>("formatterMode", "bundled"),
    },
  };
  const text = JSON.stringify(report, null, 2);
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage("Bend 2 support diagnostics copied without source code.");
}

async function updateCompilerStatus(): Promise<void> {
  if (!compilerStatus) return;
  const adapter = toolchain();
  if (!adapter) {
    compilerStatus.hide();
    return;
  }
  compilerStatus.show();
  compilerStatus.text = "$(sync~spin) Bend 2";
  const info = await adapter.discover();
  if (info.available) {
    compilerStatus.text = `${info.compatibility === "unsupported" ? "$(warning)" : "$(check)"} Bend ${info.version ?? "unknown"}`;
    compilerStatus.tooltip = `Active compiler: ${info.displayPath} (${info.compatibility} compatibility)`;
  } else {
    compilerStatus.text = "$(error) Bend unavailable";
    compilerStatus.tooltip = info.error ?? "Bend 2 was not found.";
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  compilerProblems = vscode.languages.createDiagnosticCollection("bend2-compiler");
  context.subscriptions.push(compilerProblems);
  compilerStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  compilerStatus.command = "bend2.showVersion";
  compilerStatus.name = "Bend 2 Compiler";
  compilerStatus.accessibilityInformation = { label: compilerStatusAccessibilityLabel() };
  context.subscriptions.push(compilerStatus);
  void updateCompilerStatus();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("bend2")) void updateCompilerStatus();
    if (event.affectsConfiguration("bend2.validationMode")) void syncValidationModeExplicitness();
  }));

  const proofExplorer = new ProofExplorer(context);
  registerProofTests(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("bend2.proofExplorer", proofExplorer),
    vscode.commands.registerCommand("bend2.openLaw", openLaw),
    vscode.commands.registerCommand("bend2.refreshProofExplorer", () => proofExplorer.refresh()),
  );

  const serverCandidates = [
    context.asAbsolutePath("server/server.js"),
    context.asAbsolutePath("../../packages/language-server/dist/server.js"),
  ];
  const serverModule = serverCandidates.find((candidate) => fs.existsSync(candidate));
  if (!serverModule) {
    vscode.window.showErrorMessage("Bend 2 language server is missing. Run npm run build first.");
  } else {
    const serverOptions: ServerOptions = {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
    };
    const bendWatcher = vscode.workspace.createFileSystemWatcher("**/*.bend");
    context.subscriptions.push(bendWatcher);
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: "file", language: "bend" }],
      synchronize: { configurationSection: "bend2", fileEvents: bendWatcher },
      initializationOptions: { clientPlatform: process.platform, remoteName: vscode.env.remoteName ?? null, uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop" },
      outputChannelName: "Bend 2 Language Server",
    };
    client = new LanguageClient("bend2-language-server", "Bend 2 Language Server", serverOptions, clientOptions);
    context.subscriptions.push(client);
    void client.start().then(() => syncValidationModeExplicitness());
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("bend2.checkFile", checkFile),
    vscode.commands.registerCommand("bend2.checkWorkspace", checkWorkspace),
    vscode.commands.registerCommand("bend2.runProjectGate", () => runGate("check")),
    vscode.commands.registerCommand("bend2.runSabotage", () => runGate("sabotage")),
    vscode.commands.registerCommand("bend2.buildFile", buildFile),
    vscode.commands.registerCommand("bend2.runFile", runFile),
    vscode.commands.registerCommand("bend2.probeBackend", probeBackend),
    vscode.commands.registerCommand("bend2.compareBackends", compareBackends),
    vscode.commands.registerCommand("bend2.compareProjectBackends", compareProjectBackends),
    vscode.commands.registerCommand("bend2.benchmarkFile", benchmarkFile),
    vscode.commands.registerCommand("bend2.showBase", showBase),
    vscode.commands.registerCommand("bend2.showVersion", showVersion),
    vscode.commands.registerCommand("bend2.showExecutionEnvironment", showExecutionEnvironment),
    vscode.commands.registerCommand("bend2.copySupportDiagnostics", () => copySupportDiagnostics(context)),
    vscode.commands.registerCommand("bend2.openProof", openProof),
    vscode.commands.registerCommand("bend2.showProofDetails", showProofDetails),
    vscode.commands.registerCommand("bend2.showProofGoal", showProofGoal),
    vscode.commands.registerCommand("bend2.checkProof", checkProof),
    vscode.commands.registerCommand("bend2.reviewLawChanges", reviewLawChanges),
    vscode.commands.registerCommand("bend2.restartLanguageServer", async () => {
      await client?.restart();
    }),
  );
}

async function syncValidationModeExplicitness(): Promise<void> {
  if (!client) return;
  const inspection = vscode.workspace.getConfiguration("bend2").inspect<string>("validationMode");
  const explicit = Boolean(inspection && [inspection.globalValue, inspection.workspaceValue, inspection.workspaceFolderValue, inspection.globalLanguageValue, inspection.workspaceLanguageValue, inspection.workspaceFolderLanguageValue].some((value) => value !== undefined));
  try {
    await client.sendRequest("bend2/validationModeExplicitness", { explicit });
  } catch {
    // The language client may still be starting or shutting down.
  }
}

export async function deactivate(): Promise<void> {
  cancelToolchainProcesses();
  await client?.stop();
}
