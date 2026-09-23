# Release roadmap

This roadmap describes broad release goals. It does not promise dates. Release notes describe what is available today.

## 0.1 — Preview

Publish the current feature set for early use and feedback. Some language intelligence and proof details are provisional because they use a tolerant source parser where Bend does not expose stable semantic data.

## 1.0 — Reliable core

Make the everyday editing loop dependable: syntax and formatting, compiler diagnostics with compatibility fallback, check/build/run commands, completion and navigation, signature help, and basic proof workflows. Document supported Bend and VS Code environments and validate each supported mode before release.

## 1.x — Bend-aware intelligence

Improve semantic features using compiler-provided data. Explore affine-usage and proof-goal views, then add parallel and GPU insights when the compiler can provide useful measured data.

## 2.0 — Semantic IDE

If a major compatibility change is needed, consolidate compiler-backed types, source spans, proof context, affine usage, and execution insights into a deeper Bend-aware editor experience. If these capabilities can ship compatibly, they may arrive in 1.x instead.

Package/Hub tooling, foreign C/JavaScript workflows, and interactive debugging remain areas for future evaluation; they are not release commitments.
