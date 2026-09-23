import assert from "node:assert/strict";
import test from "node:test";
import { resolveValidationMode } from "../validationMode.js";

test("uses compiler-on-save as the default validation mode", () => {
  assert.equal(resolveValidationMode({ modeExplicit: false }), "onSave");
});

test("keeps the deprecated validation=false setting working unless the new mode is explicit", () => {
  assert.equal(resolveValidationMode({ legacyValidation: false, modeExplicit: false }), "off");
  assert.equal(resolveValidationMode({ legacyValidation: false, configuredMode: "onType", modeExplicit: true }), "onType");
  assert.equal(resolveValidationMode({ legacyValidation: false, configuredMode: "onSave", modeExplicit: true }), "onSave");
});

test("preserves every explicitly selected validation mode", () => {
  for (const configuredMode of ["parser", "onSave", "onType", "off"] as const) {
    assert.equal(resolveValidationMode({ configuredMode, modeExplicit: true }), configuredMode);
  }
});
