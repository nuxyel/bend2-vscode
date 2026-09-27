# Support policy

This document defines the compatibility boundary for the Bend 2 VS Code extension.

## Supported versions

| Component | Supported baseline | Behavior outside the baseline |
| --- | --- | --- |
| Bend compiler | `2.0.28` or newer within the `2.x` major line | Versions below `2.0.28` and other major versions are marked unsupported; compiler-backed operations may fail with an actionable message |
| Host platform | Linux/macOS, or Windows through WSL/remote workspace | Native Windows compiler discovery explains the WSL or remote-workspace requirement |
| Unversioned or unreadable Bend executable | Not verified | Marked unverified; parser features remain available and compiler commands may still be attempted |
| VS Code desktop/remote | 1.90 or newer | The extension cannot be installed on older hosts |
| VS Code Web | Current browser host with workspace file access | Process-dependent compiler, proof and execution commands explain that a desktop or remote host is required |
| Development and packaging runtime | Node.js 22 or newer | Required only for contributors and release builds; the published VSIX bundles its runtime dependencies |

The adapter requires Bend `2.0.28` or newer in the `2.x` major line. The dogfood verification matrix pins Bend `2.0.28` as its minimum and the latest stable release observed on 2026-09-27, Bend `2.0.32` ([Bend 2.0.28](https://github.com/bendlang/bend/releases/tag/v2.0.28), [Bend 2.0.32](https://github.com/bendlang/bend/releases/tag/v2.0.32)). Both releases have official checksum pins in the dogfood matrix and passed local proof checks and Stable desktop integration for this candidate. CI runs the same matrix; repeat it on the final tagged commit before making a release support claim. The active version and revision are reported in the status bar and support diagnostics.

The VS Code Web host supports process-free editing features such as parsing, formatting and workspace navigation. `check`, `run`, build and compiler-backed proof checks require a desktop or remote extension host that can launch Bend.

## Deprecation policy

- New compiler protocols are introduced behind an explicit setting or capability check before becoming the default.
- The human-readable diagnostic parser remains as a fallback while the structured protocol is experimental or unavailable.
- Structured diagnostics are used when the active Bend compiler exposes a supported transport; otherwise the extension uses its compatibility parser.
- Text fallback records normalize open goals, unsafe/foreign dependencies and import failures into consistent diagnostic categories.
- Launcher-based environments can set `bend2.executablePath` and `bend2.executableArgs`; compiler arguments stay on the remote host when using WSL, SSH or a container wrapper.
- See [`REMOTE-HOSTS.md`](REMOTE-HOSTS.md) for launcher examples and the supported argument-ordering contract.
- A deprecated extension setting or command remains documented for at least one stable release and emits a migration path before removal.
- Removing support for a Bend major version requires a changelog entry and a release note identifying the last supported extension version.
- Unsupported or unknown versions are never silently treated as supported. The status bar, support diagnostics and compiler-facing messages preserve that distinction.
- Security or host-platform issues may require an exception to the normal deprecation window; such exceptions must be documented in the changelog.

## Reporting compatibility issues

Include the source-free report from `Bend 2: Copy Support Diagnostics`, the extension version, the Bend version/revision and the host mode (desktop, remote or web). Do not attach source code unless it is intentionally minimized and reviewed first.
