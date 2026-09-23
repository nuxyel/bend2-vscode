import test from "node:test";
import assert from "node:assert/strict";
import { groupTestCases } from "../testRunPlan.js";

test("groups a proof suite and selected law cases into one compiler target", () => {
  const project = { id: "project" };
  const lawA = { id: "law-a" };
  const lawB = { id: "law-b" };
  const groups = groupTestCases([
    { key: "proof.bend", item: project, children: [lawA, lawB] },
    { key: "proof.bend", item: lawA },
  ]);

  assert.deepEqual([...groups.keys()], ["proof.bend"]);
  assert.deepEqual([...groups.get("proof.bend") ?? []], [project, lawA, lawB]);
});

test("keeps different proof files as separate compiler targets", () => {
  const first = { id: "first" };
  const second = { id: "second" };
  const groups = groupTestCases([
    { key: "one/PROOF.bend", item: first },
    { key: "two/PROOF.bend", item: second },
  ]);

  assert.equal(groups.size, 2);
  assert.deepEqual([...groups.get("one/PROOF.bend") ?? []], [first]);
  assert.deepEqual([...groups.get("two/PROOF.bend") ?? []], [second]);
});
