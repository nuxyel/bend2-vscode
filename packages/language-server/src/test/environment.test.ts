import assert from "node:assert/strict";
import test from "node:test";
import { environmentLabel, platformMismatchMessage, remoteEnvironment } from "../environment.js";

test("does not report a platform mismatch when hosts agree or client metadata is absent", () => {
  assert.equal(platformMismatchMessage("linux", "linux"), undefined);
  assert.equal(platformMismatchMessage(undefined, "win32"), undefined);
});

test("reports an actionable platform mismatch", () => {
  const message = platformMismatchMessage("win32", "linux");
  assert.match(message ?? "", /extension host reports 'win32'/);
  assert.match(message ?? "", /configure Bend 2 there/);
});

test("classifies supported VS Code remote environments", () => {
  assert.equal(remoteEnvironment(undefined), "local");
  assert.equal(remoteEnvironment("wsl"), "wsl");
  assert.equal(remoteEnvironment("ssh-remote"), "ssh");
  assert.equal(remoteEnvironment("dev-container"), "dev-container");
  assert.equal(remoteEnvironment("github-codespaces"), "codespaces");
  assert.equal(remoteEnvironment("web", "web"), "web");
  assert.equal(remoteEnvironment("custom-remote"), "remote");
});

test("labels every environment in user-facing diagnostics", () => {
  for (const environment of ["local", "wsl", "ssh", "dev-container", "codespaces", "web", "remote"] as const) {
    assert.ok(environmentLabel(environment).length > 0);
  }
  assert.match(platformMismatchMessage("win32", "linux", "wsl") ?? "", /in WSL/);
  assert.match(platformMismatchMessage("win32", "linux", "ssh-remote") ?? "", /in SSH remote/);
  assert.match(platformMismatchMessage("win32", "linux", "dev-container") ?? "", /in Dev Container/);
});
