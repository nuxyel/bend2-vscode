import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkSpeedup } from "../benchmarkPresentation.js";

const baseline = { medianMs: 100, outputSha1: "same", outputsMatch: true };

test("reports speedup only for comparable stable outputs", () => {
  assert.equal(benchmarkSpeedup(baseline, { medianMs: 25, outputSha1: "same", outputsMatch: true }), 4);
  assert.equal(benchmarkSpeedup(baseline, { medianMs: 25, outputSha1: "different", outputsMatch: true }), null);
  assert.equal(benchmarkSpeedup(baseline, { medianMs: 25, outputSha1: "same", outputsMatch: false }), null);
  assert.equal(benchmarkSpeedup(undefined, { medianMs: 25, outputSha1: "same", outputsMatch: true }), null);
});
