## 0.1.0

- Initial public release of the hardened Flutter web bootstrap CLI.
- Commands: `install`, `uninstall`, `package`, `doctor`.
- Versioned packaging under `/version/<build>/` with gzip boot files, SHA-256
  checks, resumable downloads, background sideload, and hard-update mode.
- Direct version URL support for pinned builds.
- Portable `installed.json` paths (always forward slashes).
- Docs: default nginx caching without CSP; optional CSP section for HTML docs.
- Tests: Dart CLI/e2e, Node unit tests, Chrome e2e (stub + real Flutter).
