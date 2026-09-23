import assert from "node:assert/strict";
import test from "node:test";
import { CheckScheduler } from "../checkScheduler.js";

test("cancels a running compiler check during shutdown", async () => {
  let signal: AbortSignal | undefined;
  const scheduler = new CheckScheduler((_uri, nextSignal) => {
    signal = nextSignal;
    return new Promise<void>(() => undefined);
  });
  scheduler.schedule("file:///main.bend", true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scheduler.size, 1);
  scheduler.cancelAll();
  assert.equal(signal?.aborted, true);
  assert.equal(scheduler.size, 0);
});

test("replaces a delayed check without running the stale request", async () => {
  const started: string[] = [];
  const scheduler = new CheckScheduler((uri) => { started.push(uri); }, 20);
  scheduler.schedule("file:///stale.bend");
  scheduler.schedule("file:///current.bend", true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ["file:///current.bend"]);
  scheduler.cancelAll();
});

test("cleans up a failed check without an unhandled rejection", async () => {
  const scheduler = new CheckScheduler(async () => {
    throw new Error("compiler crashed");
  });
  scheduler.schedule("file:///failed.bend", true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scheduler.size, 0);
});
