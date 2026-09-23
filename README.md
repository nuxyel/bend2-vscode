# Bend 2 for VS Code

Language support and development tools for [Bend 2](https://github.com/HigherOrderCO/Bend).
The extension includes syntax highlighting, formatting, compiler checks, execution commands,
workspace navigation, and a proof explorer.

The project is in preview. Some editor intelligence and proof details are inferred from source
text until Bend provides stable semantic and diagnostic interfaces. Compiler-backed features
require Bend 2 to be installed in the VS Code workspace environment.

## Features

- Bend 2 syntax highlighting, snippets, and formatting.
- Compiler diagnostics and commands to check, build, and run Bend files.
- Completion, hover, symbols, and navigation across local Bend files.
- Proof Explorer for laws and proof files, with checker status when available.
- JavaScript, native CPU, and GPU execution profiles where supported by the compiler.
- Desktop, remote workspace, and browser-safe editor support with capability differences shown in the UI.

See the [release notes](apps/vscode/CHANGELOG.md) for delivered changes and the [public roadmap](docs/ROADMAP.md) for version themes.

## Development

Requirements:

- Node.js 22 or newer.
- VS Code 1.90 or newer for extension development.
- Bend 2 installed for compiler-backed commands.

```bash
npm install
npm run check
npm run test:dogfood
npm run package
```

The dogfood command runs the checked-in `LAWS.bend`/`PROOF.bend` project with a
compiler version from `tests/dogfood/compiler-versions.json`. On Linux or WSL,
install the pinned release first with `node scripts/install-dogfood-compiler.mjs <version>`;
the installer verifies the official release checksum. The regular
cross-platform `npm run check` does not require Bend.

The VS Code host smoke test can be run separately with `npm run test:integration`; set `VSCODE_VERSION=insiders` to target Insiders.

The VS Code Web smoke test can be run with `npm run test:web`; it opens the bundled browser extension in headless Chromium and checks activation, symbols and parser diagnostics.

`npm run package` builds and verifies a self-contained VSIX. `npm run test:integration` runs the desktop
host smoke test, and `npm run test:web` runs the browser-host smoke test. See [`docs/RELEASING.md`](docs/RELEASING.md)
for release packaging details and [`docs/SUPPORT.md`](docs/SUPPORT.md) for compatibility information.

Open this repository in VS Code and press `F5` to launch the Extension Development Host.

## Design principles

1. **The compiler is the source of truth.** The extension must not silently invent a different Bend language.
2. **Laws belong to humans.** The extension can navigate, explain and verify `LAWS.bend`, but it never rewrites laws automatically.
3. **Every expensive operation is cancellable.** Typing must remain responsive while the checker runs in the background.
4. **Version mismatches are visible.** The active Bend executable and supported compiler version are always shown to the user.
5. **No mandatory telemetry.** Diagnostics and source code stay local unless the user explicitly chooses otherwise.

## Contributing

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. Changes to the language adapter must include fixtures and a compatibility note for the Bend version they target.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
