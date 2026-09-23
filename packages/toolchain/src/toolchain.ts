import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ToolchainSource = "configured" | "workspace-bun" | "workspace-script" | "workspace-gate" | "path";
export type DiagnosticSeverity = "error" | "warning" | "info";
export type DiagnosticsMode = "auto" | "text" | "json";
export type DiagnosticTransport = "structured" | "text" | "none";
export type CompilerCompatibility = "supported" | "unknown" | "unsupported";
export type GateKind = "check" | "sabotage";
export type BackendProfile = "javascript" | "native" | "gpu";
export type CapabilityStatus = "supported" | "unsupported" | "unknown";
export type ProbeStatus = "ready" | "unsupported" | "unavailable" | "failed" | "cancelled";
export type DiagnosticCategory = "general" | "type" | "proof-goal" | "unsafe" | "foreign" | "import";

export interface ToolchainInvocation {
  command: string;
  argsPrefix: string[];
  source: ToolchainSource;
  displayPath: string;
}

export interface CompilerInfo extends ToolchainInvocation {
  version: string | null;
  revision?: string;
  compatibility: CompilerCompatibility;
  available: boolean;
  capabilities?: CompilerCapabilities;
  error?: string;
}

export interface CompilerCapabilities {
  javascript: CapabilityStatus;
  native: CapabilityStatus;
  gpu: CapabilityStatus;
  threads: CapabilityStatus;
  source: "guide" | "help" | "unknown";
}

export interface CompilerDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  code?: string;
  expectedType?: string;
  observedType?: string;
  category?: DiagnosticCategory;
  proofContext?: string[];
  proofDependencies?: string[];
  message: string;
  severity: DiagnosticSeverity;
  relatedInformation?: CompilerRelatedInformation[];
  /** Compiler-defined fields retained for forward-compatible protocol clients. */
  extensions?: Record<string, unknown>;
}

export interface CompilerRelatedInformation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  /** Compiler-defined fields retained for forward-compatible protocol clients. */
  extensions?: Record<string, unknown>;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface CheckResult extends CommandResult {
  diagnostics: CompilerDiagnostic[];
  diagnosticTransport: DiagnosticTransport;
  diagnosticProtocolVersion?: number;
}

export interface GateResult extends CommandResult {
  diagnostics: CompilerDiagnostic[];
  diagnosticTransport: DiagnosticTransport;
  diagnosticProtocolVersion?: number;
}

export interface StructuredDiagnosticsResult {
  diagnostics: CompilerDiagnostic[];
  protocolVersion?: number;
}

export interface BenchmarkOptions {
  threads?: number;
  gpu?: string;
  runs?: number;
  warmup?: boolean;
  signal?: AbortSignal;
}

export interface ExecutionOptions {
  profile?: BackendProfile;
  threads?: number;
  gpuMemory?: string;
  signal?: AbortSignal;
}

export interface BackendProbeResult {
  profile: BackendProfile;
  status: ProbeStatus;
  compiler: CompilerInfo;
  check?: CheckResult;
  build?: CommandResult;
  execute?: CommandResult;
  message: string;
}

export interface DifferentialRun {
  profile: BackendProfile;
  result: CommandResult;
  outputSha1: string | null;
}

export interface DifferentialResult {
  runs: DifferentialRun[];
  comparable: boolean;
  outputsMatch: boolean;
  error?: string;
}

export interface DifferentialManifest {
  files: string[];
  profiles: BackendProfile[];
  threads?: number;
  gpuMemory?: string;
}

export interface DifferentialProjectRun {
  file: string;
  result: DifferentialResult;
}

export interface DifferentialProjectResult {
  runs: DifferentialProjectRun[];
  comparable: boolean;
  outputsMatch: boolean;
  error?: string;
}

export interface BenchmarkResult {
  ok: boolean;
  compiler: CompilerInfo;
  compile: CommandResult;
  runs: number;
  warmup: boolean;
  threads: number | null;
  gpu: string;
  machine: { platform: string; arch: string; cpuCount: number };
  samplesMs: number[];
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  outputsMatch: boolean;
  outputSha1: string | null;
  error?: string;
}

export interface ToolchainOptions {
  workspaceRoot: string;
  executablePath?: string;
  executableArgs?: string[];
  timeoutMs?: number;
  diagnosticsMode?: DiagnosticsMode;
}

export function compilerUnavailableMessage(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "Bend 2 was not found. Native Windows is not supported by the compiler; install or configure Bend 2 through WSL, or use a Linux/macOS remote workspace.";
  }
  return "Bend 2 was not found or could not run. Install it or configure bend2.executablePath.";
}

function versionOf(output: string): string | null {
  return /\b(?:Bend\s+)?(\d+\.\d+\.\d+)\b/i.exec(output)?.[1] ?? null;
}

function revisionOf(output: string): string | undefined {
  return /\b[0-9a-f]{7,40}\b/i.exec(output)?.[0];
}

export function compilerCompatibility(version: string | null): CompilerCompatibility {
  if (!version) return "unknown";
  return version.startsWith("2.") ? "supported" : "unsupported";
}

export function parseCompilerCapabilities(output: string, source: "guide" | "help"): CompilerCapabilities {
  const has = (positive: RegExp, negative: RegExp): CapabilityStatus => negative.test(output) ? "unsupported" : positive.test(output) ? "supported" : "unknown";
  return {
    javascript: has(/JavaScript target|JS backend|file\.js/i, /JavaScript[^\r\n.;]*(?:not|unavailable|unsupported|disabled)/i),
    native: has(/native (?:binary|executable)|compile(?:s|d)? .*C|clang/i, /native[^\r\n.;]*(?:not|unavailable|unsupported|disabled)/i),
    gpu: has(/--gpu|GPU/i, /(?:no|without|missing|unavailable|unsupported|disabled)[^\r\n.;]*GPU|GPU[^\r\n.;]*(?:not|unavailable|unsupported|disabled)/i),
    threads: has(/--threads|thread counts?|CPU threads?/i, /threads?[^\r\n.;]*(?:not|unavailable|unsupported|disabled)/i),
    source,
  };
}

export function backendCapability(info: CompilerInfo, profile: BackendProfile): CapabilityStatus {
  return info.capabilities?.[profile] ?? "unknown";
}

function invocationFor(file: string, source: ToolchainSource): ToolchainInvocation {
  const normalized = path.resolve(file);
  if (normalized.endsWith(".ts")) {
    return { command: "bun", argsPrefix: [normalized], source, displayPath: normalized };
  }
  if (process.platform === "win32" && (normalized.endsWith(".cmd") || normalized.endsWith(".bat"))) {
    return { command: process.env.ComSpec ?? "cmd.exe", argsPrefix: ["/d", "/c", "call", normalized], source, displayPath: normalized };
  }
  if (process.platform === "win32" && (normalized.endsWith(".sh") || hasBashShebang(normalized))) {
    return { command: "bash", argsPrefix: [normalized], source, displayPath: normalized };
  }
  return { command: normalized, argsPrefix: [], source, displayPath: normalized };
}

function hasBashShebang(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]?.includes("bash") ?? false;
  } catch {
    return false;
  }
}

function hasRunnableMain(file: string): boolean {
  try {
    return /^\s*def\s+main\s*\(/m.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function configuredInvocation(value: string, source: ToolchainSource, extraArgs: string[] = []): ToolchainInvocation {
  if (value.includes("/") || value.includes("\\") || path.isAbsolute(value)) {
    const invocation = invocationFor(value, source);
    // Script launchers (bun, bash and Windows cmd wrappers) need their own
    // prefix first; arguments for the configured launcher follow the script.
    const argsPrefix = invocation.argsPrefix.length > 0
      ? [...invocation.argsPrefix, ...extraArgs]
      : [...extraArgs];
    return { ...invocation, argsPrefix };
  }
  return { command: value, argsPrefix: extraArgs, source, displayPath: value };
}

function gateInvocation(file: string): ToolchainInvocation {
  const normalized = path.resolve(file);
  if (normalized.endsWith(".sh")) return { command: "bash", argsPrefix: [normalized], source: "workspace-gate", displayPath: normalized };
  if (normalized.endsWith(".ps1")) return { command: process.platform === "win32" ? "powershell.exe" : "pwsh", argsPrefix: ["-NoProfile", "-File", normalized], source: "workspace-gate", displayPath: normalized };
  return invocationFor(normalized, "workspace-gate");
}

function gateCandidates(root: string, kind: GateKind): string[] {
  const name = kind === "check" ? "check" : "sabotagem";
  return [
    path.join(root, "scripts", `${name}.sh`),
    path.join(root, "scripts", `${name}.ps1`),
    path.join(root, "scripts", `${name}.cmd`),
  ];
}

export function parseCompilerDiagnostics(output: string, fallbackFile: string): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const unix = /^(.*):(\d+):(\d+):\s*(?:(error|warning|note)\s*:?\s*)?(.*)$/i.exec(line);
    const windows = /^(.*)\((\d+),(\d+)\):\s*(?:(error|warning|note)\s*:?\s*)?(.*)$/i.exec(line);
    const match = unix ?? windows;
    if (!match) continue;
    const message = match[5] || match[4] || "Compiler diagnostic";
    const kind = (match[4] ?? "error").toLowerCase();
    const category = diagnosticCategory(message);
    const severity = category === "proof-goal" || category === "unsafe" || category === "foreign"
      ? "warning"
      : kind === "warning" ? "warning" : kind === "note" ? "info" : "error";
    diagnostics.push({
      file: match[1] || fallbackFile,
      line: Math.max(0, Number(match[2]) - 1),
      column: Math.max(0, Number(match[3]) - 1),
      message,
      severity,
      ...(category === "general" ? {} : { category }),
    });
  }
  if (diagnostics.length > 0) return diagnostics;
  const bendErrors = parseBendErrorDiagnostics(output, fallbackFile);
  return bendErrors.length > 0 ? bendErrors : parseBendSafetyReport(output, fallbackFile);
}

/**
 * Parse the current Bend CLI's human-readable `Error:` report.
 *
 * Bend deliberately prints source context instead of a compiler-style
 * `file:line:column` record. The marked `>|` line is still authoritative for
 * navigation, so preserve it as a line-start diagnostic until the upstream
 * compiler exposes column spans through a stable protocol.
 */
export function parseBendErrorDiagnostics(output: string, fallbackFile: string): CompilerDiagnostic[] {
  const lines = output.split(/\r?\n/);
  const diagnostics: CompilerDiagnostic[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^Error:\s*/.test(lines[index] ?? "")) continue;
    const fields = new Map<string, string>();
    let locationStart = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (/^Error:\s*/.test(line)) {
        index = cursor - 1;
        break;
      }
      if (/^Location:/.test(line)) {
        locationStart = cursor + 1;
        break;
      }
      const field = /^-\s+([A-Za-z][A-Za-z ]*)\s*:\s*(.*)$/.exec(line);
      if (field) fields.set(field[1].trim().toLowerCase(), field[2].trim());
    }

    let line = 0;
    if (locationStart >= 0) {
      let firstContextLine: number | undefined;
      for (let cursor = locationStart; cursor < lines.length; cursor += 1) {
        const context = /^\s*(\d+)\s*([>|])\s*\|/.exec(lines[cursor] ?? "");
        if (!context) {
          if (/^Error:\s*/.test(lines[cursor] ?? "")) {
            index = cursor - 1;
            break;
          }
          continue;
        }
        const parsed = Math.max(0, Number(context[1]) - 1);
        firstContextLine ??= parsed;
        if (context[2] === ">") {
          line = parsed;
          break;
        }
        line = firstContextLine;
      }
    }

    const expectedType = fields.get("expected");
    const observedType = fields.get("observed");
    const message = fields.get("message")
      ?? (expectedType !== undefined || observedType !== undefined
        ? [expectedType === undefined ? "" : `expected ${expectedType}`, observedType === undefined ? "" : `observed ${observedType}`].filter(Boolean).join("; ")
        : "Compiler error");
    const category = diagnosticCategory(message);
    const severity: DiagnosticSeverity = category === "proof-goal" || category === "unsafe" || category === "foreign"
      ? "warning"
      : "error";
    diagnostics.push({
      file: fallbackFile,
      line,
      column: 0,
      message,
      severity,
      ...(expectedType === undefined ? {} : { expectedType }),
      ...(observedType === undefined ? {} : { observedType }),
      ...(category === "general" ? {} : { category }),
    });
  }
  return diagnostics;
}

/** Parse the successful-check warning emitted for unsafe/foreign dependencies. */
export function parseBendSafetyReport(output: string, fallbackFile: string): CompilerDiagnostic[] {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) => /^All terms check, but \d+ defs? rel(?:y|ies|ied) on unsafe or foreign code:\s*$/.test(line.trim()));
  if (header < 0) return [];
  const diagnostics: CompilerDiagnostic[] = [];
  for (let index = header + 1; index < lines.length; index += 1) {
    const match = /^\s*-\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (!match) continue;
    const name = match[1];
    const message = `Definition '${name}' relies on unsafe or foreign code.`;
    const location = sourceDefinitionLocation(fallbackFile, name);
    diagnostics.push({
      file: fallbackFile,
      line: location.line,
      column: location.column,
      endLine: location.line,
      endColumn: location.column + (location.foundName ? location.foundName.length : 1),
      message,
      severity: "warning",
      category: "unsafe",
    });
  }
  return diagnostics;
}

function sourceDefinitionLocation(file: string, qualifiedName: string): { line: number; column: number; foundName?: string } {
  const name = qualifiedName.split(".").at(-1) ?? qualifiedName;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { line: 0, column: 0 };
  try {
    const sourceLines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declaration = new RegExp(`^\\s*(?:def|law|type)\\s+${escaped}\\b`);
    for (let line = 0; line < sourceLines.length; line += 1) {
      if (!declaration.test(sourceLines[line] ?? "")) continue;
      const column = Math.max(0, (sourceLines[line] ?? "").indexOf(name));
      return { line, column, foundName: name };
    }
  } catch {
    // Imported or generated definitions may not exist in the checked file.
  }
  return { line: 0, column: 0 };
}

export function shouldRetryTextDiagnostics(result: CommandResult): boolean {
  if (result.code === 0 || result.cancelled || result.timedOut) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return /(?:--diagnostics(?:=json)?|diagnostics).*(?:unknown|unrecognized|invalid|unexpected|unsupported)|(?:unknown|unrecognized|invalid|unexpected|unsupported).*(?:--diagnostics(?:=json)?|diagnostics)/i.test(output);
}

export function shouldRetryCheckOnly(result: CommandResult): boolean {
  if (result.code === 0 || result.cancelled || result.timedOut) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return /(?:--check-only|check-only).*(?:unknown|unrecognized|invalid|unexpected|unsupported)|(?:unknown|unrecognized|invalid|unexpected|unsupported).*--check-only/i.test(output);
}

export function runtimeArguments(options: ExecutionOptions = {}): string[] {
  const profile = options.profile ?? "javascript";
  const args: string[] = [];
  if (profile !== "javascript") {
    if (options.threads !== undefined) {
      if (!Number.isInteger(options.threads) || options.threads < 1) throw new Error("threads must be a positive integer");
      args.push("--threads", String(options.threads));
    }
    if (profile === "gpu") {
      const memory = options.gpuMemory ?? "on";
      if (!/^(?:on|\d+(?:\.\d+)?(?:KB|MB|GB|TB))$/i.test(memory)) throw new Error("gpuMemory must be 'on' or a memory limit such as '4GB'");
      args.push("--gpu", memory);
    }
  }
  return args;
}

export function parseDifferentialManifest(value: unknown): DifferentialManifest {
  if (!value || typeof value !== "object") throw new Error("Differential manifest must be a JSON object.");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.files) || record.files.length === 0 || record.files.some((file) => typeof file !== "string" || file.trim().length === 0)) {
    throw new Error("Differential manifest requires a non-empty 'files' array of relative Bend files.");
  }
  const files = [...new Set(record.files.map((file) => String(file).trim()))];
  if (files.some((file) => path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))) {
    throw new Error("Differential manifest files must stay inside the workspace.");
  }
  const rawProfiles = record.profiles === undefined ? ["javascript", "native"] : record.profiles;
  if (!Array.isArray(rawProfiles) || rawProfiles.length < 2 || rawProfiles.some((profile) => !["javascript", "native", "gpu"].includes(String(profile)))) {
    throw new Error("Differential manifest requires at least two valid profiles: javascript, native or gpu.");
  }
  const profiles = [...new Set(rawProfiles.map((profile) => String(profile) as BackendProfile))];
  if (profiles.length < 2) throw new Error("Differential manifest requires at least two different profiles.");
  const threads = record.threads === undefined ? undefined : Number(record.threads);
  if (threads !== undefined && (!Number.isInteger(threads) || threads < 1)) throw new Error("Differential manifest 'threads' must be a positive integer.");
  const gpuMemory = record.gpuMemory === undefined ? undefined : String(record.gpuMemory);
  if (gpuMemory !== undefined && !/^(?:on|\d+(?:\.\d+)?(?:KB|MB|GB|TB))$/i.test(gpuMemory)) throw new Error("Differential manifest 'gpuMemory' must be 'on' or a memory limit such as '4GB'.");
  return { files, profiles, ...(threads === undefined ? {} : { threads }), ...(gpuMemory === undefined ? {} : { gpuMemory }) };
}

export async function loadDifferentialManifest(workspaceRoot: string, relativePath = path.join(".bend2", "differential.json")): Promise<DifferentialManifest> {
  const root = path.resolve(workspaceRoot);
  const manifestPath = path.resolve(root, relativePath);
  const relative = path.relative(root, manifestPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Differential manifest must stay inside the workspace.");
  const content = await fs.promises.readFile(manifestPath, "utf8");
  try {
    const manifest = parseDifferentialManifest(JSON.parse(content));
    for (const file of manifest.files) {
      const candidate = path.resolve(root, file);
      if (path.extname(candidate).toLowerCase() !== ".bend" || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        throw new Error(`Differential input '${file}' must be an existing .bend file inside the workspace.`);
      }
    }
    return manifest;
  } catch (error) {
    throw new Error(`Invalid differential manifest '${relativePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

function diagnosticSeverity(value: unknown): DiagnosticSeverity {
  const severity = String(value ?? "error").toLowerCase();
  return severity === "warning" || severity === "warn" ? "warning" : severity === "info" || severity === "note" ? "info" : "error";
}

function diagnosticCategory(value: unknown): DiagnosticCategory {
  const category = String(value ?? "").toLowerCase().replace(/[ _]/g, "-");
  if (category.includes("type")) return "type";
  if (category.includes("unsafe")) return "unsafe";
  if (category.includes("foreign")) return "foreign";
  if (category.includes("import") || category.includes("no-such-file") || category.includes("missing-file")) return "import";
  if (category.includes("proof") || category.includes("goal") || category.includes("hole")) return "proof-goal";
  return "general";
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map((item) => typeof item === "string" ? item : item && typeof item === "object" && "name" in item ? String((item as { name: unknown }).name) : String(item)).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function unknownFields(record: Record<string, unknown>, known: readonly string[]): Record<string, unknown> | undefined {
  const knownKeys = new Set(known);
  const entries = Object.entries(record).filter(([key]) => !knownKeys.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function gateResult(result: CommandResult, fallbackFile: string): GateResult {
  const output = `${result.stdout}\n${result.stderr}`;
  const structured = parseStructuredDiagnosticsDetailed(output, fallbackFile);
  if (structured.diagnostics.length > 0) return { ...result, diagnostics: structured.diagnostics, diagnosticTransport: "structured", ...(structured.protocolVersion === undefined ? {} : { diagnosticProtocolVersion: structured.protocolVersion }) };
  const text = parseCompilerDiagnostics(output, fallbackFile);
  return { ...result, diagnostics: text, diagnosticTransport: text.length > 0 ? "text" : "none" };
}

function structuredItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.diagnostics)) return object.diagnostics;
  if (object.diagnostic) return [object.diagnostic];
  if (object.message || object.reason) return [object];
  return [];
}

export function parseStructuredDiagnosticsDetailed(output: string, fallbackFile: string): StructuredDiagnosticsResult {
  const values: unknown[] = [];
  try {
    values.push(JSON.parse(output.trim()));
  } catch {
    // Some compiler frontends emit one JSON diagnostic per line. Ignore non-JSON
    // progress output and keep the structured records that can be decoded.
    for (const line of output.split(/\r?\n/)) {
      try {
        values.push(JSON.parse(line.trim()));
      } catch {
        // Compatibility fallback is handled by parseCompilerDiagnostics().
      }
    }
  }
  const protocolVersion = values.map((value) => value && typeof value === "object" && !Array.isArray(value) ? Number((value as Record<string, unknown>).protocolVersion) : NaN).find((value) => Number.isInteger(value) && value > 0);
  const diagnostics = values.flatMap((value) => structuredItems(value)).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const range = record.range && typeof record.range === "object" ? record.range as Record<string, unknown> : record;
    const start = (range.start && typeof range.start === "object" ? range.start : range) as Record<string, unknown>;
    const end = (range.end && typeof range.end === "object" ? range.end : {}) as Record<string, unknown>;
    const line = Number(start.line ?? start.lineNumber ?? 1);
    const column = Number(start.column ?? start.character ?? 1);
    if (!Number.isFinite(line) || !Number.isFinite(column)) return [];
    const endLine = Number(end.line ?? end.lineNumber ?? line);
    const endColumn = Number(end.column ?? end.character ?? column + 1);
    const related = record.relatedInformation ?? record.related ?? record.notes;
    const relatedInformation = Array.isArray(related)
      ? related.flatMap((entry): CompilerRelatedInformation[] => {
          if (!entry || typeof entry !== "object") return [];
          const note = entry as Record<string, unknown>;
          const noteRange = note.range && typeof note.range === "object" ? note.range as Record<string, unknown> : note;
          const noteStart = (noteRange.start && typeof noteRange.start === "object" ? noteRange.start : noteRange) as Record<string, unknown>;
          const noteEnd = (noteRange.end && typeof noteRange.end === "object" ? noteRange.end : {}) as Record<string, unknown>;
          const noteLine = Number(noteStart.line ?? noteStart.lineNumber ?? 1);
          const noteColumn = Number(noteStart.column ?? noteStart.character ?? 1);
          if (!Number.isFinite(noteLine) || !Number.isFinite(noteColumn)) return [];
          const noteEndLine = Number(noteEnd.line ?? noteEnd.lineNumber ?? noteLine);
          const noteEndColumn = Number(noteEnd.column ?? noteEnd.character ?? noteColumn + 1);
          const extensions = unknownFields(note, ["file", "path", "range", "start", "end", "line", "lineNumber", "column", "character", "endLine", "endColumn", "message", "reason"]);
          return [{
            file: String(note.file ?? note.path ?? fallbackFile),
            line: Math.max(0, noteLine > 0 ? noteLine - 1 : noteLine),
            column: Math.max(0, noteColumn > 0 ? noteColumn - 1 : noteColumn),
            endLine: Math.max(0, noteEndLine > 0 ? noteEndLine - 1 : noteEndLine),
            endColumn: Math.max(0, noteEndColumn > 0 ? noteEndColumn - 1 : noteEndColumn),
            message: String(note.message ?? note.reason ?? "Compiler note"),
            ...(extensions ? { extensions } : {}),
          }];
        })
      : undefined;
    const category = diagnosticCategory(record.category ?? record.kind ?? record.type);
    const extensions = unknownFields(record, ["file", "path", "range", "start", "end", "line", "lineNumber", "column", "character", "endLine", "endColumn", "code", "expectedType", "expected", "observedType", "observed", "actual", "category", "kind", "type", "context", "locals", "dependencies", "proofDependencies", "message", "reason", "severity", "relatedInformation", "related", "notes"]);
    return [{
      file: String(record.file ?? record.path ?? fallbackFile),
      line: Math.max(0, line > 0 ? line - 1 : line),
      column: Math.max(0, column > 0 ? column - 1 : column),
      endLine: Math.max(0, endLine > 0 ? endLine - 1 : endLine),
      endColumn: Math.max(0, endColumn > 0 ? endColumn - 1 : endColumn),
      code: record.code === undefined ? undefined : String(record.code),
      ...(record.expectedType === undefined && record.expected === undefined ? {} : { expectedType: String(record.expectedType ?? record.expected) }),
      ...(record.observedType === undefined && record.observed === undefined && record.actual === undefined ? {} : { observedType: String(record.observedType ?? record.observed ?? record.actual) }),
      ...(category === "general" ? {} : { category }),
      ...(stringList(record.context ?? record.locals) ? { proofContext: stringList(record.context ?? record.locals) } : {}),
      ...(stringList(record.dependencies ?? record.proofDependencies) ? { proofDependencies: stringList(record.dependencies ?? record.proofDependencies) } : {}),
      message: String(record.message ?? record.reason ?? "Compiler diagnostic"),
      severity: diagnosticSeverity(record.severity ?? record.kind),
      ...(relatedInformation && relatedInformation.length > 0 ? { relatedInformation } : {}),
      ...(extensions ? { extensions } : {}),
    }];
  });
  return { diagnostics, ...(protocolVersion === undefined ? {} : { protocolVersion }) };
}

export function parseStructuredDiagnostics(output: string, fallbackFile: string): CompilerDiagnostic[] {
  return parseStructuredDiagnosticsDetailed(output, fallbackFile).diagnostics;
}

const activeToolchainCancellations = new Set<() => void>();

export function cancelToolchainProcesses(): void {
  for (const cancel of [...activeToolchainCancellations]) cancel();
}

export function runToolchain(invocation: ToolchainInvocation, args: string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
      return;
    }
    const child = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 10_000);
    const abort = () => {
      cancelled = true;
      child.kill();
    };
    activeToolchainCancellations.add(abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    child.on("error", (error) => stderr.push(error.message));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeToolchainCancellations.delete(abort);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout: stdout.join(""), stderr: stderr.join(""), timedOut, cancelled });
    });
  });
}

export class BendToolchain {
  private readonly options: ToolchainOptions;
  private cached: CompilerInfo | undefined;

  constructor(options: ToolchainOptions) {
    this.options = options;
  }

  async discover(): Promise<CompilerInfo> {
    if (this.cached) return this.cached;
    const configured = this.options.executablePath;
    const candidates: ToolchainInvocation[] = [];
    if (configured && configured !== "bend") candidates.push(configuredInvocation(configured, "configured", this.options.executableArgs));
    const localBun = path.join(this.options.workspaceRoot, ".bend", "bend2", "main.ts");
    const localScript = path.join(this.options.workspaceRoot, "bin", "bend");
    if (fs.existsSync(localBun)) candidates.push(invocationFor(localBun, "workspace-bun"));
    if (fs.existsSync(localScript)) candidates.push(invocationFor(localScript, "workspace-script"));
    candidates.push(configuredInvocation(configured || "bend", "path", this.options.executableArgs));

    for (const candidate of candidates) {
      const versionAttempts = ["--version", "version"];
      let result = await runToolchain(candidate, [versionAttempts[0]], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs ?? 3_000 });
      if (result.code !== 0) {
        result = await runToolchain(candidate, [versionAttempts[1]], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs ?? 3_000 });
      }
      if (result.code === 0) {
        const versionOutput = `${result.stdout}\n${result.stderr}`;
        const version = versionOf(versionOutput);
        const guide = await runToolchain(candidate, ["guide"], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs ?? 5_000 });
        const capabilityOutput = `${guide.stdout}\n${guide.stderr}`;
        const capabilities = guide.code === 0 && capabilityOutput.trim().length > 0
          ? parseCompilerCapabilities(capabilityOutput, "guide")
          : (() => {
            const help = runToolchain(candidate, ["--help"], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs ?? 5_000 });
            return help.then((resultHelp) => resultHelp.code === 0 && `${resultHelp.stdout}\n${resultHelp.stderr}`.trim().length > 0
              ? parseCompilerCapabilities(`${resultHelp.stdout}\n${resultHelp.stderr}`, "help")
              : undefined);
          })();
        this.cached = { ...candidate, version, revision: revisionOf(versionOutput), compatibility: compilerCompatibility(version), available: true, capabilities: await capabilities };
        return this.cached;
      }
    }
    this.cached = { ...candidates[0], version: null, compatibility: "unknown", available: false, error: compilerUnavailableMessage() };
    return this.cached;
  }

  async check(file: string, signal?: AbortSignal): Promise<CheckResult> {
    const compiler = await this.discover();
    if (!compiler.available) return { code: null, stdout: "", stderr: compiler.error ?? "Bend 2 unavailable.", timedOut: false, cancelled: false, diagnostics: [], diagnosticTransport: "none" };
    const mode = this.options.diagnosticsMode ?? "auto";
    // Never execute a program while validating it. Current Bend exposes
    // --check-only; the fallback keeps compatibility with older launchers.
    const args = [file, "--check-only"];
    if (mode === "json") args.push("--diagnostics=json");
    let result = await runToolchain(compiler, args, { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal });
    if (mode === "json" && shouldRetryTextDiagnostics(result)) {
      result = await runToolchain(compiler, [file, "--check-only"], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal });
    }
    if (shouldRetryCheckOnly(result)) {
      if (hasRunnableMain(file)) {
        const message = "The configured Bend compiler does not support --check-only; validation was stopped to avoid executing main(). Upgrade Bend or run the check command manually.";
        return {
          ...result,
          code: result.code ?? 2,
          stderr: `${result.stderr}\n${message}`.trim(),
          diagnostics: [{ file, line: 0, column: 0, message, severity: "error" }],
          diagnosticTransport: "text",
        };
      }
      result = await runToolchain(compiler, [file], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal });
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const structured = mode === "text" ? { diagnostics: [] } : parseStructuredDiagnosticsDetailed(output, file);
    if (structured.diagnostics.length > 0) return { ...result, diagnostics: structured.diagnostics, diagnosticTransport: "structured", ...(structured.protocolVersion === undefined ? {} : { diagnosticProtocolVersion: structured.protocolVersion }) };
    const text = parseCompilerDiagnostics(output, file);
    return { ...result, diagnostics: text, diagnosticTransport: text.length > 0 ? "text" : "none" };
  }

  async run(file: string, options: ExecutionOptions = {}): Promise<CommandResult> {
    const compiler = await this.discover();
    if (!compiler.available) return { code: null, stdout: "", stderr: compiler.error ?? "Bend 2 unavailable.", timedOut: false, cancelled: false };
    const profile = options.profile ?? "javascript";
    if (profile === "javascript") return runToolchain(compiler, [file], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal: options.signal });
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "bend2-run-"));
    const binary = path.join(temporaryDirectory, process.platform === "win32" ? "program.exe" : "program");
    try {
      const compile = await this.build(file, binary, { profile: "native", signal: options.signal });
      if (compile.code !== 0 || compile.cancelled || compile.timedOut) return compile;
      const execute = await runToolchain({ command: binary, argsPrefix: [], source: "configured", displayPath: binary }, runtimeArguments(options), { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal: options.signal });
      return { ...execute, stdout: `${compile.stdout}${execute.stdout}`, stderr: `${compile.stderr}${execute.stderr}` };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async probe(file: string, profile: BackendProfile, signal?: AbortSignal): Promise<BackendProbeResult> {
    const compiler = await this.discover();
    if (!compiler.available) return { profile, status: "unavailable", compiler, message: compiler.error ?? "Bend 2 is unavailable." };
    const capability = backendCapability(compiler, profile);
    if (capability === "unsupported") return { profile, status: "unsupported", compiler, message: `The active Bend compiler does not advertise the ${profile} backend.` };
    if (profile === "javascript") {
      const check = await this.check(file, signal);
      if (check.cancelled) return { profile, status: "cancelled", compiler, check, message: "The JavaScript backend probe was cancelled." };
      return { profile, status: check.code === 0 ? "ready" : "failed", compiler, check, message: check.code === 0 ? "The JavaScript checker accepted the file." : check.stderr || "The JavaScript backend check failed." };
    }
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "bend2-probe-"));
    const binary = path.join(temporaryDirectory, process.platform === "win32" ? "program.exe" : "program");
    try {
      const build = await this.build(file, binary, { profile: "native", signal });
      if (build.cancelled) return { profile, status: "cancelled", compiler, build, message: "The backend probe was cancelled during compilation." };
      if (build.code !== 0) return { profile, status: "failed", compiler, build, message: build.stderr || `The ${profile} backend failed during compilation.` };
      if (profile === "native") return { profile, status: "ready", compiler, build, message: "The native backend compiled the file successfully." };
      const execute = await runToolchain({ command: binary, argsPrefix: [], source: "configured", displayPath: binary }, runtimeArguments({ profile: "gpu", gpuMemory: "on" }), { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal });
      if (execute.cancelled) return { profile, status: "cancelled", compiler, build, execute, message: "The GPU probe was cancelled during execution." };
      return { profile, status: execute.code === 0 ? "ready" : "failed", compiler, build, execute, message: execute.code === 0 ? "The GPU backend executed with --gpu on." : execute.stderr || "The GPU backend could not execute with --gpu on." };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async compareBackends(file: string, profiles: BackendProfile[] = ["javascript", "native"], options: Omit<ExecutionOptions, "profile"> = {}): Promise<DifferentialResult> {
    const selected = [...new Set(profiles)];
    if (selected.length < 2) return { runs: [], comparable: false, outputsMatch: false, error: "Choose at least two execution backends." };
    const runs: DifferentialRun[] = [];
    for (const profile of selected) {
      const result = await this.run(file, { ...options, profile });
      runs.push({
        profile,
        result,
        outputSha1: result.code === 0 ? createHash("sha1").update(result.stdout).digest("hex") : null,
      });
      if (result.cancelled || result.timedOut) break;
    }
    const comparable = runs.length === selected.length && runs.every((run) => run.result.code === 0 && !run.result.cancelled && !run.result.timedOut);
    const hashes = new Set(runs.map((run) => run.outputSha1).filter((hash): hash is string => hash !== null));
    return {
      runs,
      comparable,
      outputsMatch: comparable && hashes.size === 1,
      ...(comparable && hashes.size !== 1 ? { error: "Backends produced different stdout." } : {}),
    };
  }

  async compareProject(files: string[], profiles: BackendProfile[] = ["javascript", "native"], options: Omit<ExecutionOptions, "profile"> = {}): Promise<DifferentialProjectResult> {
    if (files.length === 0) return { runs: [], comparable: false, outputsMatch: false, error: "The differential project has no input files." };
    const runs: DifferentialProjectRun[] = [];
    for (const file of files) {
      const result = await this.compareBackends(file, profiles, options);
      runs.push({ file, result });
      if (!result.comparable && result.runs.some((run) => run.result.cancelled || run.result.timedOut)) break;
    }
    const comparable = runs.length === files.length && runs.every((run) => run.result.comparable);
    const outputsMatch = comparable && runs.every((run) => run.result.outputsMatch);
    const error = runs.find((run) => run.result.error)?.result.error;
    return { runs, comparable, outputsMatch, ...(error ? { error } : {}) };
  }

  async build(file: string, output: string, options: ExecutionOptions = {}): Promise<CommandResult> {
    const compiler = await this.discover();
    if (!compiler.available) return { code: null, stdout: "", stderr: compiler.error ?? "Bend 2 unavailable.", timedOut: false, cancelled: false };
    return runToolchain(compiler, [file, "-o", output], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal: options.signal });
  }

  async base(name?: string, signal?: AbortSignal): Promise<CommandResult> {
    const compiler = await this.discover();
    if (!compiler.available) return { code: null, stdout: "", stderr: compiler.error ?? "Bend 2 unavailable.", timedOut: false, cancelled: false };
    return runToolchain(compiler, ["base", ...(name ? [name] : [])], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal });
  }

  async runGate(kind: GateKind, target?: string, signal?: AbortSignal): Promise<GateResult> {
    let args: string[] = [];
    if (target) {
      const root = path.resolve(this.options.workspaceRoot);
      const resolvedTarget = path.resolve(root, target);
      const relativeTarget = path.relative(root, resolvedTarget);
      if (relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
        return gateResult({ code: null, stdout: "", stderr: "Gate target must stay inside the Bend 2 workspace.", timedOut: false, cancelled: false }, target ?? "workspace");
      }
      if (process.platform === "win32" && /[&|<>^%!]/.test(relativeTarget)) {
        return gateResult({ code: null, stdout: "", stderr: "Gate target contains characters that cannot be passed safely to a Windows command script.", timedOut: false, cancelled: false }, target ?? "workspace");
      }
      args = [relativeTarget || "."];
    }
    const script = gateCandidates(this.options.workspaceRoot, kind).find((candidate) => fs.existsSync(candidate));
    if (!script) {
      return gateResult({
        code: null,
        stdout: "",
        stderr: `Bend 2 ${kind} gate was not found under ${path.join(this.options.workspaceRoot, "scripts")}.`,
        timedOut: false,
        cancelled: false,
      }, target ?? "workspace");
    }
    try {
      if (process.platform === "win32" && script.toLowerCase().endsWith(".cmd")) {
        return gateResult(await runToolchain({
          command: process.env.ComSpec ?? "cmd.exe",
          argsPrefix: ["/d", "/c", "call", script, ...args],
          source: "workspace-gate",
          displayPath: script,
        }, [], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs ?? 120_000, signal }), target ?? "workspace");
      }
      return gateResult(await runToolchain(gateInvocation(script), args, { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs ?? 120_000, signal }), target ?? "workspace");
    } catch (error) {
      return gateResult({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, cancelled: false }, target ?? "workspace");
    }
  }

  async benchmark(file: string, options: BenchmarkOptions = {}): Promise<BenchmarkResult> {
    const compiler = await this.discover();
    const runs = Math.max(1, Math.min(20, Math.floor(options.runs ?? 3)));
    const warmup = options.warmup ?? true;
    const threads = options.threads === undefined ? null : Math.max(1, Math.floor(options.threads));
    const gpu = options.gpu ?? "off";
    const machine = { platform: process.platform, arch: process.arch, cpuCount: os.cpus().length };
    const unavailable: CommandResult = { code: null, stdout: "", stderr: compiler.error ?? "Bend 2 unavailable.", timedOut: false, cancelled: false };
    const empty = { ok: false, compiler, compile: unavailable, runs, warmup, threads, gpu, machine, samplesMs: [], medianMs: null, minMs: null, maxMs: null, outputsMatch: false, outputSha1: null };
    if (!compiler.available) return { ...empty, error: compiler.error };

    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "bend2-benchmark-"));
    const binary = path.join(temporaryDirectory, process.platform === "win32" ? "program.exe" : "program");
    try {
      const compile = await runToolchain(compiler, [file, "-o", binary], { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal: options.signal });
      if (compile.code !== 0 || compile.cancelled || compile.timedOut) return { ...empty, compile, error: compile.stderr || "Bend 2 compilation failed." };

      const args = [
        ...(threads === null ? [] : ["--threads", String(threads)]),
        "--gpu", gpu,
      ];
      const execute = async (): Promise<{ result: CommandResult; elapsedMs: number }> => {
        const started = performance.now();
        const result = await runToolchain({ command: binary, argsPrefix: [], source: "configured", displayPath: binary }, args, { cwd: this.options.workspaceRoot, timeoutMs: this.options.timeoutMs, signal: options.signal });
        return { result, elapsedMs: performance.now() - started };
      };
      if (warmup) {
        const first = await execute();
        if (first.result.code !== 0 || first.result.cancelled || first.result.timedOut) return { ...empty, compile, error: first.result.stderr || "Bend 2 warm-up failed." };
      }
      const measured: Array<{ elapsedMs: number; stdout: string }> = [];
      for (let index = 0; index < runs; index += 1) {
        if (options.signal?.aborted) return { ...empty, compile, error: "Benchmark cancelled." };
        const execution = await execute();
        if (execution.result.code !== 0 || execution.result.cancelled || execution.result.timedOut) return { ...empty, compile, error: execution.result.stderr || "Bend 2 benchmark run failed." };
        measured.push({ elapsedMs: execution.elapsedMs, stdout: execution.result.stdout });
      }
      const samplesMs = measured.map((item) => item.elapsedMs);
      const outputHashes = new Set(measured.map((item) => createHash("sha1").update(item.stdout).digest("hex")));
      return {
        ok: true,
        compiler,
        compile,
        runs,
        warmup,
        threads,
        gpu,
        machine,
        samplesMs,
        medianMs: median(samplesMs),
        minMs: Math.min(...samplesMs),
        maxMs: Math.max(...samplesMs),
        outputsMatch: outputHashes.size <= 1,
        outputSha1: outputHashes.values().next().value ?? null,
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
