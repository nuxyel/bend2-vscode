# Accessibility review checklist

The repository has automated coverage for the Proof Details HTML contract. A manual review is still required in a real VS Code desktop installation with a screen reader because the extension host and screen-reader bridge are not available in every CI environment.

## Automated contract

Run:

```bash
npm run test --workspace apps/vscode
```

The accessibility test verifies:

- a labelled `main` landmark;
- labelled sections for the proposition, context, proof definition, dependencies and checker notes;
- a live proof-status announcement;
- keyboard-focusable proof code blocks;
- HTML and CSP nonce escaping.

The accessibility-label tests also verify the Proof Explorer project, file, law,
dependency and compiler-status labels for every proof state, including `unsafe`,
`foreign`, `missing proof` and `not checked`.

## Manual desktop review

Use a clean checkout with a workspace containing `LAWS.bend`, `PROOF.bend` and an optional `UNSAFE_OK` file.

1. Open the Proof Explorer view and navigate the project, law file, proof file and dependency nodes using only the keyboard.
2. Confirm each tree item announces its project/file/law role and status, including `not checked`, `unsafe`, `foreign` and `missing proof`.
3. Open Proof Details from a law CodeLens and move through the panel with `Tab` and the screen reader's heading navigation.
4. Confirm the panel exposes one heading for the law, labelled sections for every proof detail, and a status announcement that includes the current proof state.
5. Focus each proof/context code block and verify that long lines can be reviewed without losing the current section.
6. Run a check that changes a law from `not checked` to `proved` or `failed` and confirm the updated status is announced.
7. Open the Problems panel for a parser diagnostic and verify that its message, severity and source are announced.
8. Repeat the review at 200% zoom and with high contrast enabled.

Record the screen reader, VS Code version, operating system, workspace fixture and any issue before release. Do not mark this checklist complete based only on the automated test.
