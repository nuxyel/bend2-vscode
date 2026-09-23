import assert from "node:assert/strict";
import test from "node:test";
import { compilerStatusAccessibilityLabel, dependencyAccessibilityLabel, fileAccessibilityLabel, lawAccessibilityLabel, projectAccessibilityLabel } from "../accessibilityLabels.js";

test("keeps Proof Explorer labels descriptive across every proof status", () => {
  assert.equal(projectAccessibilityLabel("examples"), "Bend 2 project examples");
  assert.equal(fileAccessibilityLabel("LAWS.bend"), "LAWS.bend file");
  assert.equal(dependencyAccessibilityLabel("algebra.assoc"), "Proof dependency algebra.assoc");
  for (const status of ["proved", "open", "failed", "unsafe", "foreign", "not checked", "missing proof"] as const) {
    assert.equal(lawAccessibilityLabel("add_commutative", status, 0), `Law add_commutative, status ${status}`);
    assert.equal(lawAccessibilityLabel("add_commutative", status, 2), `Law add_commutative, status ${status}, 2 proof dependencies`);
  }
});

test("keeps the compiler status label stable for screen-reader users", () => {
  assert.equal(compilerStatusAccessibilityLabel(), "Bend 2 compiler status");
});
