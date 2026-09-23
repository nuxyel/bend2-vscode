# Bend 2 extension dogfood project

This tiny project gives the extension a real Bend workspace to exercise. It
contains a module import, a compiler-checked law, and a recursive proof. The
project deliberately stays small so failures point to editor/compiler
integration rather than application complexity.

With Bend 2 installed, run `npm run test:dogfood`. The minimum and current
latest compiler targets, with official Linux release SHA-256 pins, are recorded
in `compiler-versions.json`. CI verifies each downloaded archive against its
pin, then checks `proof-project/PROOF.bend` without running a `main` function.

Open `tests/dogfood/proof-project` as a VS Code workspace to try the same files
with the extension. `app.bend` exercises imported definition navigation and
Signature Help; the Proof Explorer should report
`adding_zero_preserves_value` as `proved` after the compiler check, and as
`not checked` when no compiler is available.
