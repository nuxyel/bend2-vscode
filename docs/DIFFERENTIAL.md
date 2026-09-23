# Differential backend suites

The `Bend 2: Compare Project Backends` command runs the same inputs through multiple compiler execution profiles and compares their stdout hashes. It never reports a speedup; a result is only considered comparable when every selected backend completes successfully.

Create `.bend2/differential.json` at the workspace root:

```json
{
  "files": [
    "projetos/example/main.bend",
    "projetos/example/another_input.bend"
  ],
  "profiles": ["javascript", "native"],
  "threads": 4,
  "gpuMemory": "on"
}
```

`files` must contain relative paths inside the workspace. `profiles` requires at least two of `javascript`, `native` and `gpu`; it defaults to `javascript` and `native`. `threads` must be a positive integer, and `gpuMemory` must be `on` or a value such as `4GB`.

The suite runs sequentially, preserves per-file exit codes and output hashes, and stops early when a backend is cancelled or times out. Use the single-file command when exploring a file interactively.
