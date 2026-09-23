import assert from "node:assert/strict";
import test from "node:test";
import { callContextAt, parseBendSignature } from "../signatureHelp.js";

test("parses annotated parameters with nested delimiters", () => {
  const signature = parseBendSignature("def combine(left: List(Nat), right: Option((Nat, Nat))):\n  left", "combine");
  assert.deepEqual(signature?.parameters.map((parameter) => parameter.label), ["left: List(Nat)", "right: Option((Nat, Nat))"]);
  assert.equal(signature?.label, "def combine(left: List(Nat), right: Option((Nat, Nat)))");
});

test("retains useful signature help for incomplete declarations", () => {
  const signature = parseBendSignature("def incomplete(first: Nat, second:", "incomplete");
  assert.deepEqual(signature?.parameters.map((parameter) => parameter.label), ["first: Nat", "second:"]);
});

test("finds the current argument while ignoring nested commas", () => {
  const source = "combine((1, 2), nested(3, 4), ";
  assert.deepEqual(callContextAt(source, source.length), { name: "combine", activeParameter: 2 });
});
