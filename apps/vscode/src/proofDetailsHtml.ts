export interface ProofDetailsHtmlInput {
  lawName: string;
  status: string;
  statement: string;
  context: string;
  proof: string;
  dependencies: string[];
  notes: string[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function detailsHtml(nonce: string, details: ProofDetailsHtmlInput): string {
  const list = (items: string[], empty: string): string => items.length > 0
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}';"><style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0 1.5rem;line-height:1.45}h1{font-size:1.4rem}h2{font-size:1rem;margin-top:1.6rem;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:.25rem}pre{background:var(--vscode-textCodeBlock-background);padding:.8rem;overflow:auto;border-radius:4px}.badge{display:inline-block;padding:.15rem .5rem;border-radius:1rem;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.muted{opacity:.75}ul{padding-left:1.4rem}
  </style></head><body><main aria-labelledby="proof-title"><h1 id="proof-title">${escapeHtml(details.lawName)} <span class="badge" role="status" aria-live="polite" aria-label="Proof status: ${escapeHtml(details.status)}">${escapeHtml(details.status)}</span></h1>
    <section aria-labelledby="proposition-heading"><h2 id="proposition-heading">Expected proposition</h2><pre tabindex="0">${escapeHtml(details.statement)}</pre></section>
    <section aria-labelledby="context-heading"><h2 id="context-heading">Proof context</h2><pre tabindex="0">${escapeHtml(details.context || "No proof context is available.")}</pre></section>
    <section aria-labelledby="definition-heading"><h2 id="definition-heading">Proof definition</h2><pre tabindex="0">${escapeHtml(details.proof || "No proof definition was found.")}</pre></section>
    <section aria-labelledby="dependencies-heading"><h2 id="dependencies-heading">Dependencies</h2>${list(details.dependencies, "No call-shaped proof dependencies were detected.")}</section>
    <section aria-labelledby="notes-heading"><h2 id="notes-heading">Checker notes</h2>${list(details.notes, "No compiler notes are available. Run a project check with a Bend compiler to refresh this section.")}</section>
  </main></body></html>`;
}
