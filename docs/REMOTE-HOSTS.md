# Remote host configuration

Bend 2 compiler processes run in the VS Code workspace host. Open the folder through WSL, Remote-SSH, a Dev Container or Codespaces so the compiler and the language server see the same files.

The extension accepts a launcher in `bend2.executablePath` and arguments that must be placed before the Bend command in `bend2.executableArgs`:

```json
{
  "bend2.executablePath": "wsl.exe",
  "bend2.executableArgs": ["--distribution", "Ubuntu", "--exec", "bend"]
}
```

Equivalent launcher shapes are supported for SSH and containers:

```json
{
  "bend2.executablePath": "ssh",
  "bend2.executableArgs": ["bend-host", "bend"]
}
```

```json
{
  "bend2.executablePath": "docker",
  "bend2.executableArgs": ["exec", "bend-dev", "bend"]
}
```

The extension appends the compiler operation after this prefix, for example `--version`, `guide` or `<file> --check-only`. The launcher itself must therefore accept the Bend command at the end of the configured argument list.

The checked-in fixture [`remote-launchers.json`](../packages/toolchain/src/test/fixtures/remote-launchers.json) and toolchain test exercise the ordering contract without requiring WSL, SSH or Docker to be installed on the test runner. Live host validation remains part of the release checklist.

If the client and workspace host run on different platforms, the language server reports the active remote environment and an actionable mismatch warning. Use **Bend 2: Show Execution Environment** to copy a source-free report for troubleshooting.
