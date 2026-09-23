# Bend 2 for VS Code

Proof-aware language support and developer tools for [Bend 2](https://github.com/bendlang/bend).

## Features

- Syntax highlighting, snippets, indentation, folding, semantic tokens and outline symbols.
- Completion, hover, go to definition, type definition, references, rename and workspace symbol search.
- Signature Help for local and imported functions, including available parameter annotations; signatures are parser-derived rather than inferred.
- Direct call hierarchy for indexed Bend functions and laws.
- Local import links and optional automatic import edits through `bend2.autoImport`.
- Parser diagnostics while editing, with compiler diagnostics on save by default or while typing when selected.
- Bundled Bend 2 formatter with comment, line-ending and final-newline preservation.
- Proof Explorer for `LAWS.bend` and `PROOF.bend`, including `proved`, `open`, `failed`, `unsafe`, `foreign`, `not checked` and `missing proof` states.
- Test Explorer checks for discovered `PROOF.bend` files.
- Test Explorer exposes laws as child cases and clearly labels that they run their containing `PROOF.bend` check.
- Running a containing proof suite updates its law cases from the same compiler result.
- Test Explorer also runs the workspace Project Gate when a conventional gate script is available.
- Check, build, run, Base lookup and benchmark commands.
- Backend probe command for compiler acceptance, native compilation and opt-in active GPU execution.
- Execution Environment diagnostics for local, WSL, SSH, Dev Container and Web host troubleshooting.
- Project Gate and Sabotage Check commands for conventional `scripts/check.*` and `scripts/sabotagem.*` workspace entry points.
- Reproducible benchmarks with warm-up, median, output hashes, machine metadata and measured speedup.
- Opt-in project differential suites from `.bend2/differential.json`, with per-input hashes and no unmeasured equivalence claims.
- Benchmark results can be saved as source-free JSON reports for later comparison.
- Support diagnostics copy only environment, compiler and extension settings metadata; source code is excluded.
- VS Code Web provides syntax, formatting, folding, semantic tokens, completion, hover and parser-backed navigation; compiler, proof and execution commands explain when a desktop or remote host is required.
- Law review is read-only and shows the selected `LAWS.bend` diff against `HEAD`; the extension never rewrites laws.
- The Web entrypoint includes document symbols, workspace symbol search, completion, hover, document links, references, rename, type definition and same-file or workspace-wide Go to Definition without a compiler process.
- Web workspace indexing and cross-file navigation are delegated to a bundled Web Worker, with a parser fallback for constrained hosts.
- VS Code Web also shows source-free parser diagnostics for duplicate declarations, open proof goals and unsafe/foreign markers.
- Remote workspaces run the language server and compiler on the workspace host through VS Code's workspace extension kind.

## Requirements

- VS Code 1.90 or newer.
- Bend 2 for compiler-backed checks, builds, runs, proofs and benchmarks.
- Node.js 22 or newer only when developing or packaging this repository; the published VSIX bundles its runtime dependencies.

The extension discovers Bend in this order: the configured executable, a workspace-local `.bend/bend2/main.ts`, a workspace-local `bin/bend`, and `PATH`.

## Commands

Open the Command Palette and search for `Bend 2`:

- Check Current File
- Check Workspace
- Run Project Gate
- Run Sabotage Check
- Build Current File
- Run Current File
- Probe a Backend (compiler acceptance, native build or active GPU execution)
- Compare Backends
- Compare Project Backends (uses `.bend2/differential.json`)
- Benchmark Current File
- Show Base Definition
- Show Compiler Version
- Show Execution Environment
- Copy Support Diagnostics (source-free by default)
- Restart Language Server
- Open Proof
- Show Proof Details
- Show Proof Goal
- Check Proof
- Review Law Changes (read-only)
- Refresh Proof Explorer

Compiler, proof and execution commands require a desktop or remote VS Code host
with Bend process access. In VS Code Web, these commands explain why they are
unavailable; parser-backed editing, navigation and diagnostics remain available.

## Settings

- `bend2.executablePath`: compiler executable or launcher; defaults to `bend`.
- `bend2.executableArgs`: arguments inserted before compiler arguments; use this for launchers such as `wsl.exe` with `["bend"]` or `["-d", "Ubuntu", "bend"]`.
- `bend2.validationMode`: `parser`, `onSave`, `onType` or `off`.
- `bend2.diagnosticsMode`: `auto`, `text` or experimental `json`.
- `bend2.autoImport`: offer workspace completion items that add an import; disabled by default.
- `bend2.formatterMode`: `bundled` or `disabled`.

## Safety and limitations

The extension never rewrites `LAWS.bend` automatically. Compiler work runs outside the editor process, has timeouts and supports cancellation. The semantic index is tolerant while a document is incomplete; compiler-backed spans and types remain the source of truth when Bend provides them.

Project backend suites must contain a relative `files` array and at least two profiles (`javascript`, `native` or `gpu`). Optional `threads` and `gpuMemory` values are validated before execution. See the repository's [`docs/DIFFERENTIAL.md`](https://github.com/nuxyel/bend2-vscode/blob/main/docs/DIFFERENTIAL.md) for the complete schema.

Bend 2 currently has platform and compiler-version requirements of its own. The status bar marks the active compiler as supported, unverified or unsupported. GPU benchmark claims are shown only when measured outputs are stable and comparable.

## Support

- [Repository and release roadmap](https://github.com/nuxyel/bend2-vscode)
- [Supported versions and deprecation policy](https://github.com/nuxyel/bend2-vscode/blob/main/docs/SUPPORT.md)
- [Issue tracker](https://github.com/nuxyel/bend2-vscode/issues)
- [Bend 2 documentation](https://github.com/HigherOrderCO/Bend/tree/main/guide)

## License

Apache-2.0. The VSIX includes the full license and formatter attribution notice.
