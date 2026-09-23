# Contributing

Thank you for helping make Bend 2 easier to use.

## Pull requests

- Keep user-facing text in English.
- Add or update fixtures for parser, diagnostics and language-server changes.
- Do not modify or generate `LAWS.bend` files as part of tests without documenting why.
- Keep compiler-version-specific behavior inside `packages/language-server/src/bend-adapter.ts`.
- Run `npm run check` before submitting a pull request.

## Project structure

- `apps/vscode`: VS Code client, commands, configuration and packaging.
- `packages/language-server`: editor intelligence independent of VS Code.
- `syntaxes`: TextMate grammar and language configuration.
- `snippets`: starter snippets for common Bend 2 constructs.

## Compatibility

The active Bend executable is user-configurable. Features that require a newer compiler must degrade visibly and explain how to update the toolchain.
