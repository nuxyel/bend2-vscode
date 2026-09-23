# Releasing Bend 2 for VS Code

The release workflow is tag-driven and keeps publishing credentials out of the repository.

## Required repository secrets

- `VSCE_PAT`: a Visual Studio Marketplace publisher token for the `nuxyel` publisher.
- `OVSX_PAT`: an Open VSX access token for the same release.

Both secrets are optional at workflow level. The corresponding marketplace step is skipped when its token is absent; the VSIX and release metadata are still built and uploaded for inspection.

## Release process

1. Update `apps/vscode/package.json` and `apps/vscode/CHANGELOG.md`.
2. Run `npm run check`, `npm run package`, `npm run test:integration` and `npm run release:metadata && npm run verify-release-metadata` locally.
3. Create an annotated tag matching the extension version, for example `v0.1.0`.
4. Push the tag. GitHub Actions runs the full build/check suite plus Stable desktop and Web smoke tests, then builds the VSIX, verifies its contents, creates the CycloneDX SBOM and provenance record, and publishes to any marketplace whose secret is configured.

The release-metadata workflow also creates a signed GitHub artifact attestation for the VSIX using the commit-pinned release build. Maintainers can inspect or verify the attestation from the repository's Actions/attestations view or with the GitHub CLI after the workflow completes.

The publish workflow never rewrites source files or laws. Marketplace publication remains a maintainer-controlled action because it requires external credentials.

The VSIX verifier also checks the required Marketplace metadata and that every `%...%` reference in the packaged manifest has an English entry in `package.nls.json`. The metadata verifier checks that the SBOM and provenance describe the current commit, extension version and exact VSIX SHA-256 before any attestation or marketplace upload.
