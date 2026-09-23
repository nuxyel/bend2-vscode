import assert from "node:assert/strict";
import test from "node:test";
import { selectProofContext } from "../proofContext.js";

test("prefers structured compiler context over the local textual fallback", () => {
  assert.equal(selectProofContext("first local line\nsecond local line", ["x : Nat", "hypothesis"]), "x : Nat\nhypothesis");
  assert.equal(selectProofContext("local context"), "local context");
  assert.equal(selectProofContext("local context", []), "local context");
});
