export type ValidationMode = "parser" | "onSave" | "onType" | "off";

export function resolveValidationMode(options: {
  configuredMode?: ValidationMode;
  legacyValidation?: boolean;
  modeExplicit: boolean;
}): ValidationMode {
  if (options.modeExplicit) return options.configuredMode ?? "onSave";
  if (options.legacyValidation === false) return "off";
  return options.configuredMode ?? "onSave";
}
