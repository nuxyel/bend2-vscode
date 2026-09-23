export function selectProofContext(localContext: string, compilerContext?: string[]): string {
  return compilerContext && compilerContext.length > 0 ? compilerContext.join("\n") : localContext;
}
