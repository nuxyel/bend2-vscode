import assert from "node:assert/strict";
import test from "node:test";
import { detailsHtml } from "../proofDetailsHtml.js";

test("renders proof details with accessible landmarks and status", () => {
  const html = detailsHtml("nonce<&", {
    lawName: "safe < law",
    status: "not checked",
    statement: "law safe < law",
    context: "x : Nat",
    proof: "proof()",
    dependencies: ["lemma<&"],
    notes: ["Compiler note"],
  });
  assert.match(html, /<main aria-labelledby="proof-title">/);
  assert.match(html, /role="status" aria-live="polite" aria-label="Proof status: not checked"/);
  assert.match(html, /<section aria-labelledby="proposition-heading">/);
  assert.match(html, /<section aria-labelledby="context-heading">/);
  assert.match(html, /<section aria-labelledby="definition-heading">/);
  assert.match(html, /<section aria-labelledby="dependencies-heading">/);
  assert.match(html, /<section aria-labelledby="notes-heading">/);
  assert.equal((html.match(/<pre tabindex="0">/g) ?? []).length, 3);
  assert.match(html, /safe &lt; law/);
  assert.match(html, /lemma&lt;&amp;/);
  assert.match(html, /script-src 'nonce-nonce&lt;&amp;'/);
});
