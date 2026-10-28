## 0.1.3

- **Requires Flutter 3.50+** for default release builds (native `--web-content-hash`);
  older SDKs need `--no-web-content-hash` (legacy, release-local assets).
- Use Flutter native content hashing with shared immutable assets and per-release dependencies.
- Stage packaging/deployment and validate dependencies before publishing root pointers.
- Recover from deleted saved releases on HTTP 404/410, preserving offline and last-good state.
- Add preview-first dependency-aware cleanup and a standalone server executable entry point.

## 0.1.2

- Add root `/status.json` ops messages: `loading` on the boot screen, `hold`
  to pause boot with a 20s recheck, and `after` on the bottom notice bar
  (reuses the background-update bar; a real update replaces the notice).
- Persist decoded (unzipped) boot payloads in Cache Storage after the first
  gunzip so later startups can skip decompression.

## 0.1.1

- Add `example/README.md` with the install-and-package workflow.

## 0.1.0

- Initial public release of the hardened Flutter web bootstrap CLI.
- Commands: `install`, `uninstall`, `package`, `doctor`.
- Versioned packaging under `/version/<build>/` with gzip boot files, SHA-256
  checks, resumable downloads, background sideload, and hard-update mode.
- Direct version URL support for pinned builds.
- Portable `installed.json` paths (always forward slashes).
- Docs: default nginx caching without CSP; optional CSP section for HTML docs.
- Tests: Dart CLI/e2e, Node unit tests, Chrome e2e (stub + real Flutter).
