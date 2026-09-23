export type ProofAccessibilityStatus = "proved" | "open" | "failed" | "unsafe" | "foreign" | "not checked" | "missing proof";

export function projectAccessibilityLabel(projectName: string): string {
  return `Bend 2 project ${projectName}`;
}

export function fileAccessibilityLabel(fileName: string): string {
  return `${fileName} file`;
}

export function lawAccessibilityLabel(lawName: string, status: ProofAccessibilityStatus, dependencyCount: number): string {
  return `Law ${lawName}, status ${status}${dependencyCount > 0 ? `, ${dependencyCount} proof dependencies` : ""}`;
}

export function dependencyAccessibilityLabel(dependency: string): string {
  return `Proof dependency ${dependency}`;
}

export function compilerStatusAccessibilityLabel(): string {
  return "Bend 2 compiler status";
}
