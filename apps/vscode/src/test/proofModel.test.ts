import assert from "node:assert/strict";
import test from "node:test";
import { proofBody, proofGoal, proofStatus, unsafeAllowlist, unsafeReview } from "../proofModel.js";

test("extracts a law proof body without consuming the next definition", () => {
  const source = "def Laws.seats():\n  ?goal\n\ndef other():\n  0n\n";
  assert.equal(proofBody(source, "seats"), "def Laws.seats():\n  ?goal\n");
  assert.deepEqual(proofGoal(source, "seats"), { token: "?goal", offset: 20, line: 1, character: 2 });
});

test("does not treat a goal-like string or comment as the current proof goal", () => {
  const source = "def proof():\n  # ?comment\n  \"?string\"\n  exact\n";
  assert.equal(proofGoal(source, "proof"), undefined);
});

test("does not claim a proof is proved when the compiler was not available", () => {
  assert.equal(proofStatus("def proof():\n  exact\n", "proof"), "not checked");
  assert.equal(proofStatus("def proof():\n  ?goal\n", "proof"), "open");
  assert.equal(proofStatus("def proof():\n  exact\n", "proof", "passed", true), "proved");
});

test("parses UNSAFE_OK entries while ignoring comments and whitespace", () => {
  assert.deepEqual([...unsafeAllowlist("# reason\nhelper.one  # approved\n\n foreign_helper\n")], ["helper.one", "foreign_helper"]);
});

test("separates registered and unlisted proof dependencies", () => {
  assert.deepEqual(unsafeReview(["zeta", "alpha", "alpha"], new Set(["alpha"])), {
    reviewed: ["alpha"],
    unlisted: ["zeta"],
  });
});
