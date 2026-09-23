export type RemoteEnvironment = "local" | "wsl" | "ssh" | "dev-container" | "codespaces" | "web" | "remote";

export function remoteEnvironment(remoteName: string | null | undefined, uiKind?: string): RemoteEnvironment {
  if (uiKind?.toLowerCase() === "web") return "web";
  const normalized = remoteName?.toLowerCase() ?? "";
  if (!normalized) return "local";
  if (normalized.includes("wsl")) return "wsl";
  if (normalized.includes("ssh")) return "ssh";
  if (normalized.includes("dev-container") || normalized.includes("attached-container")) return "dev-container";
  if (normalized.includes("codespaces")) return "codespaces";
  return "remote";
}

export function environmentLabel(environment: RemoteEnvironment): string {
  switch (environment) {
    case "wsl": return "WSL";
    case "ssh": return "SSH remote";
    case "dev-container": return "Dev Container";
    case "codespaces": return "GitHub Codespaces";
    case "web": return "VS Code for the Web";
    case "remote": return "remote workspace";
    default: return "local workspace";
  }
}

export function platformMismatchMessage(clientPlatform: string | undefined, serverPlatform: NodeJS.Platform, remoteName?: string | null, uiKind?: string): string | undefined {
  if (!clientPlatform || clientPlatform === serverPlatform) return undefined;
  const environment = environmentLabel(remoteEnvironment(remoteName, uiKind));
  return `Bend 2 language server host mismatch in ${environment}: the extension host reports '${clientPlatform}', but the language server reports '${serverPlatform}'. Compiler commands run on the language-server host; configure Bend 2 there.`;
}
