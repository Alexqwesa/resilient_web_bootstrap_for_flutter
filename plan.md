# Implementation Plan: Native Flutter Content Hashing, Shared Assets, and Safe Deployment Cleanup

**Repository:** https://github.com/Alexqwesa/resilient_web_bootstrap_for_flutter

## Goal

Use Flutter's native `--web-content-hash` feature to share unchanged assets between releases, simplify deployment, and safely remove obsolete release code and assets.

Keep the existing resilient bootstrap features: resumable downloads, SHA-256 verification, background updates, pinned versions, rollback, and offline recovery.

**Core design decisions:**

- Use Flutter 3.50+ `--web-content-hash` for production builds.
- Do not implement another asset hashing or runtime URL-mapping system.
- Deduplicate only when both the logical asset path and content are identical.
- Store shared hashed assets in one directory, independent of release directories.
- Keep application code in immutable versioned release directories.
- Use Flutter-generated metadata to identify hashed assets.
- Track asset dependencies per release for safe garbage collection.
- Preserve the existing copy-based deployment workflow.
- Keep normal Flutter development mode working without content hashing.

## 1. Target Directory Layout

```text
web_hardened/
├── index.html
├── latest.json
│
├── assets/
│   ├── images/
│   │   ├── logo.a81f1234.png
│   │   └── logo.b92c5678.png
│   ├── fonts/
│   │   └── MyFont.83d12a90.ttf
│   ├── AssetManifest.12345678.bin
│   └── FontManifest.87654321.json
│
└── version/
    ├── 20261028120000/
    │   ├── index.html
    │   ├── latest.json
    │   ├── asset_refs.json
    │   ├── flutter_bootstrap.js
    │   ├── main.dart.f1234567.js
    │   ├── main.dart.f1234567.js.gz
    │   └── ...
    │
    └── 20261028150000/
        ├── index.html
        ├── latest.json
        ├── asset_refs.json
        ├── flutter_bootstrap.js
        ├── main.dart.a9876543.js
        ├── main.dart.a9876543.js.gz
        └── ...
```

Hashed asset filenames above are illustrative.

The common `assets/` directory is **append-only during deployment**.

When a new version contains the same logical asset with the same content, Flutter generates the same filename. The packaging command skips copying it again.

When content changes, Flutter generates a different filename. Both versions remain available until cleanup determines that the old file is no longer required.

Different logical paths with identical content may be stored separately. This is intentional.

## 2. Phase 1 — Enable Native Content Hashing

**Priority: P0**

### 2.1 Update generated build scripts

Modify:

- `tool/build_resilient_web.ps1`
- `tool/build_resilient_web.sh`
- `lib/src/cli.dart`

Tasks:

- [ ] Support `--web-content-hash` in generated production builds.
- [ ] Make content hashing the default for supported Flutter 3.50+ release builds.
- [ ] Check Flutter SDK compatibility and report unsupported versions.
- [ ] Provide `--no-web-content-hash` for legacy builds.
- [ ] Preserve all other Flutter build arguments.
- [ ] Keep `flutter run` and normal development builds unchanged.
- [ ] Reject incompatible deferred-import builds with a clear explanation.

Example:

```bash
flutter build web --release --web-content-hash
```

No custom asset loader is required in development or production.

### 2.2 Update custom bootstrap compatibility

Modify:

- `lib/templates/web/index.html`
- `lib/templates/web/flutter_bootstrap.js`
- `lib/templates/web/app_update.js`
- `lib/templates/web/flutter_bootstrap_helpers.js`

The existing bootstrap assumes filenames such as `main.dart.js`. This must change.

Tasks:

- [ ] Remove hardcoded compiled-entrypoint filename assumptions.
- [ ] Preserve Flutter's `{{flutter_js}}` and `{{flutter_build_config}}` template injection.
- [ ] Read actual entrypoint filenames from Flutter's generated build configuration.
- [ ] Support `mainJsPath`, `mainWasmPath`, and `jsSupportRuntimePath` as applicable.
- [ ] Update script interception, resumable downloading, and gzip handling for hashed entrypoints.
- [ ] Preserve existing loader progress, retries, integrity checks, and error handling.
- [ ] Ensure `web/index.html` and `web/flutter_bootstrap.js` satisfy Flutter's content-hash template validation.
- [ ] Preserve the debug-server boot path.
- [ ] Do not replace the compiled bootstrap with an unprocessed template during packaging.

For Flutter runtime asset lookup, rely on its native content-hash mapping. Do not add another path resolver or duplicate the mapping in JavaScript.

**Acceptance criteria:** An application built with `--web-content-hash` boots correctly through the resilient loader, including its existing update and recovery features.

## 3. Phase 2 — Shared Hashed Asset Storage

**Priority: P0**

### 3.1 Change the packaging process

Modify `PackageCommand` in `lib/src/cli.dart`.

Currently, packaging copies the complete Flutter build into a release directory.

Change the process:

1. Read the Flutter-generated `precache_manifest.json`.
2. Validate hashed asset entries against the actual build output.
3. Copy new hashed files from `build/web/assets/` into the shared `web_hardened/assets/` directory.
4. Skip existing identical files.
5. Copy release-specific code and bootstrap resources into `version/<id>/`.
6. Generate the release manifest with the correct code and asset bases.
7. Publish the completed release.

Tasks:

- [ ] Preserve the original Flutter-generated hashed asset filenames.
- [ ] Preserve relative paths within `assets/`.
- [ ] Never overwrite an existing shared filename with different bytes.
- [ ] Verify existing files before reusing them.
- [ ] Use full SHA-256 comparisons internally where needed to detect corruption or truncated-hash collisions.
- [ ] Stage new files before publication.
- [ ] Do not copy the complete `assets/` directory into every release.
- [ ] Ensure a clean output directory creates a fully deployable build.

Do not implement whole-bundle hashes or content-addressed blob storage.

### 3.2 Update the release manifest

Example:

```json
{
  "version": "20261028150000",
  "createdAt": "2026-10-28T08:00:00Z",
  "base": "/version/20261028150000/",
  "assetBase": "/",
  "files": []
}
```

The root-level `assetBase` points Flutter to `/assets/` through the normal `assetBase + assets/` resolution.

When the app is hosted under a subpath such as `/simops/`, use the appropriate base, for example `/simops/`.

Tasks:

- [ ] Preserve existing manifest fields.
- [ ] Add `createdAt` in UTC.
- [ ] Add `assetBase` independently of `base`.
- [ ] Use the manifest's `base` for release-specific boot code.
- [ ] Use its `assetBase` for Flutter assets.
- [ ] Preserve compatibility with old manifests that do not have `assetBase`.
- [ ] Make pinned versions use their own release manifests and asset configurations.

### 3.3 Maintain per-release cleanup metadata

Flutter already records runtime asset mappings in its generated build configuration. We do not need to duplicate them for browser loading.

However, server cleanup needs a reliable inventory of the assets required by each release.

Generate `version/<id>/asset_refs.json` from Flutter's `precache_manifest.json`, containing the actual physical asset paths required by that release.

Example:

```json
{
  "version": 1,
  "assets": [
    "assets/images/logo.a81f1234.png",
    "assets/fonts/MyFont.83d12a90.ttf",
    "assets/AssetManifest.12345678.bin"
  ]
}
```

Tasks:

- [ ] Use Flutter's generated inventory as the source of truth.
- [ ] Record exact physical asset paths, including hashes.
- [ ] Include all required files under `assets/`, not only images and fonts.
- [ ] Validate every recorded asset exists.
- [ ] Preserve dependency metadata even after old release code has been trimmed, when needed for cleanup.
- [ ] Keep this metadata out of the browser boot path.

**Acceptance criteria:** Releases A and B with unchanged assets share the same physical files and HTTP cache URLs. Changed assets coexist safely under different filenames.

## 4. Phase 3 — Safe Release Retention and Browser Recovery

**Priority: P0 — Required before automatic deletion**

### 4.1 Change `package --force`

The current implementation deletes the entire output directory.

Replace this behavior:

- [ ] Never delete the whole output directory during incremental packaging.
- [ ] Preserve existing releases and shared assets.
- [ ] Reject duplicate release IDs, even when `--force` is supplied.
- [ ] Make `--force` control replacement of generated mutable root files only.
- [ ] Write a new release into a temporary directory before publication.
- [ ] Validate all code files and asset dependencies before publishing root pointers.
- [ ] Avoid breaking the previous deployment if packaging fails.

### 4.2 Recover from deleted releases

The existing loader can remember a previously successful release in `localStorage`.

Cleanup may eventually delete that release.

Tasks:

- [ ] Detect missing code (`404` or `410`) when loading the saved release.
- [ ] Fall back to the currently published release when possible.
- [ ] Limit fallback attempts to prevent infinite startup loops.
- [ ] Distinguish deleted files from temporary network failures.
- [ ] Preserve browser-cached offline startup when possible.
- [ ] Update last-good state only after a successful boot.
- [ ] Support old and new manifest formats during recovery.

Do not interpret every network error as an expired release.

**Acceptance criteria:** A user returning after several months can boot a supported release even if the browser remembers one that has been deleted.

## 5. Phase 4 — Dependency-Aware Cleanup

**Priority: P1**

Use a mark-and-sweep algorithm: retain protected releases, collect their asset references, and delete only eligible unreferenced files.

### 5.1 Release retention

Suggested defaults:

```yaml
cleanup:
  enabled: true
  keepDays: 90
  keepReleases: 3
  assetGraceDays: 90
```

Also support two calendar months as an explicit retention option.

Tasks:

- [ ] Retain releases within the configured age threshold.
- [ ] Retain at least the configured number of recent releases.
- [ ] Always protect the root current release.
- [ ] Support optionally protected rollback releases.
- [ ] Use `createdAt` in UTC, with legacy timestamp-version fallback.
- [ ] Skip unknown releases when their age cannot be established safely.
- [ ] Never delete release directories involved in an active deployment.

### 5.2 Shared asset garbage collection

Algorithm:

1. Identify retained releases.
2. Read each retained release's `asset_refs.json`.
3. Collect the set of referenced asset paths.
4. Enumerate all physical files under shared `assets/`.
5. Preserve referenced files.
6. Preserve unreferenced files within the configured grace period.
7. Remove only eligible unreferenced files.

Tasks:

- [ ] Preserve an asset if any retained release references it.
- [ ] Remove an old hash only after all references have expired and the grace period has passed.
- [ ] Treat missing or malformed dependency metadata conservatively.
- [ ] Do not delete unrelated files in the web root.
- [ ] Validate paths and symlinks to prevent deletion outside the deployment root.
- [ ] Prevent cleanup from racing with deployment.
- [ ] Support `--dry-run` and `--apply`.
- [ ] Report retained, deleted, and skipped files with their sizes.

Example:

```bash
resilient_bootstrap cleanup --keep-days 90
resilient_bootstrap cleanup --keep-days 90 --apply
```

A finite retention period cannot guarantee that an indefinitely open browser tab will never request a removed asset. Document this limitation and allow operators to extend retention or disable asset garbage collection.

### 5.3 Server-side cleanup

Keep the cleanup implementation reusable.

- [ ] Implement core dependency and retention logic in Dart.
- [ ] Provide a server-side entry point for environments without the Flutter SDK.
- [ ] If a Python-based utility is provided, use the same manifest and cleanup rules.
- [ ] Default to preview mode.
- [ ] Keep maintenance scripts outside the public document root whenever possible.
- [ ] Avoid depending on the local build output to determine which files exist on the deployed server.

The server must be able to clean its own deployment independently of the build machine.

## 6. Phase 5 — Deployment Workflow

**Priority: P1**

### 6.1 Preserve manual copy-based deployment

The existing workflow must remain valid:

```text
Build Flutter
     ↓
Package web_hardened
     ↓
Copy files to web server
     ↓
Publish latest.json / index.html
```

However, the copy must merge files rather than delete server files absent from the latest local package.

Tasks:

- [ ] Preserve existing server-side `assets/` files during deployment.
- [ ] Copy only new or changed immutable files.
- [ ] Copy release code before publishing root pointers.
- [ ] Validate all dependencies before activation.
- [ ] Publish root files last.
- [ ] Avoid cleanup as an implicit side effect of ordinary file copying.
- [ ] Provide clear examples for Windows and Linux deployments.

### 6.2 Optional deployment helper

Consider adding a command that deploys to a local filesystem destination first:

```bash
resilient_bootstrap deploy --dest /srv/www/app
```

Expected behavior:

- Copy missing immutable assets.
- Copy the new release directory.
- Validate required dependencies.
- Publish root pointers atomically where supported.
- Optionally trigger cleanup after successful publication.

SSH and other remote deployment transports are out of scope for the initial implementation.

## 7. Phase 6 — HTTP Cache Configuration

Cache immutable files aggressively.

| Resource | Recommended policy |
|---|---|
| `/index.html` | `no-cache` |
| `/latest.json` | `no-cache` |
| `/assets/**` | `public, max-age=31536000, immutable` |
| Hashed release entrypoints | `public, max-age=31536000, immutable` |
| Other immutable release resources | Long-lived immutable caching |
| Server maintenance files | Not publicly accessible |

Tasks:

- [ ] Ensure hashed assets are served with their correct MIME types.
- [ ] Preserve HTTP byte-range support for resumable boot downloads.
- [ ] Do not double-compress generated `.gz` files.
- [ ] Exclude missing assets and compiled entrypoints from SPA fallback-to-HTML rules.
- [ ] Ensure missing files return genuine `404` responses.
- [ ] Reconcile pinned HTML cache headers with configured release retention.
- [ ] Avoid applying immutable caching to mutable, unhashed resources unintentionally, including bundled CanvasKit files.

## 8. Phase 7 — Compatibility and Migration

**Priority: P1**

Existing installations may already contain:

```text
version/<release>/assets/...
```

They must continue to work.

Tasks:

- [ ] Keep old release manifests compatible.
- [ ] Support legacy assets inside old release directories.
- [ ] Use shared root assets only for new content-hashed builds.
- [ ] Avoid migrating or rewriting published immutable versions in place.
- [ ] Never delete legacy asset directories while protected legacy releases may reference them.
- [ ] Document how older releases eventually expire.
- [ ] Make `install` update generated scripts and templates without deleting user changes unexpectedly.
- [ ] Clearly report when a package was built without native content hashing.

Do not require a one-time migration of all existing deployments.

## 9. Phase 8 — Automated Tests

Extend the existing Dart, JavaScript, and Chrome end-to-end test suites.

### Packaging tests

- [ ] Two builds with the same logical path and unchanged content produce one shared physical asset.
- [ ] Changing asset content creates another hashed file.
- [ ] Different logical paths remain separate, even when content is identical.
- [ ] Existing immutable files are not overwritten.
- [ ] An existing filename with unexpected contents causes a packaging error.
- [ ] A clean output directory produces a fully deployable package.
- [ ] Duplicate release IDs are rejected.
- [ ] Repeated packaging does not corrupt older releases.

### Bootstrap tests

- [ ] `Image.asset` works with hashed assets.
- [ ] `rootBundle.load` works with hashed assets.
- [ ] Font and asset manifests resolve correctly.
- [ ] Shaders and asset variants resolve correctly.
- [ ] Hashed JavaScript entrypoints load correctly.
- [ ] Resumable `.gz` downloads still work.
- [ ] Background updates still work.
- [ ] Pinned versions still work.
- [ ] Legacy releases without content hashing still work.
- [ ] Debug mode remains unaffected.

### Cleanup tests

- [ ] Shared assets survive when referenced by multiple retained releases.
- [ ] An asset is removed only after becoming unreferenced and passing the grace period.
- [ ] Current and protected releases are never deleted.
- [ ] Unknown dependencies prevent unsafe asset deletion.
- [ ] Dry-run never deletes files.
- [ ] Cleanup does not escape its configured directory.
- [ ] Cleanup remains safe when repeated.

### Recovery and deployment tests

- [ ] A returning browser recovers from a deleted last-good release.
- [ ] Temporary network failure does not unnecessarily discard cached state.
- [ ] Interrupted deployment preserves the previous working release.
- [ ] The root manifest is never published before dependencies are available.
- [ ] New and old browser tabs can load their respective assets during a rolling deployment.

Run end-to-end tests against a real Flutter build using `--web-content-hash`, not only synthetic fixtures.

## 10. Out of Scope

Do not implement these features unless a demonstrated requirement appears:

- A custom Dart or JavaScript asset-loading helper.
- A custom SHA-256 filename generator.
- A custom browser-side `assets.json` mapping.
- Whole-bundle comparison or whole-bundle deduplication.
- Deduplication of different logical paths with identical bytes.
- Full-hash blob storage such as `/blobs/<sha256>`.
- An asset index database.
- New service-worker infrastructure.
- Remote deployment protocols.
- CanvasKit deduplication in the first iteration.

Use Flutter's existing functionality wherever possible.

## 11. Implementation Order

1. **Native hashing compatibility:** Remove hardcoded entrypoint assumptions, support Flutter-generated hashed filenames, and verify the existing resilient loader.
2. **Shared assets:** Move native hashed assets into a common directory and add per-release dependency metadata.
3. **Safe packaging and startup recovery:** Make packaging non-destructive and recover from deleted last-good releases.
4. **Garbage collection:** Implement reference-aware release and asset cleanup.
5. **Deployment integration:** Preserve copy-based deployment and add optional deployment tooling.
6. **Compatibility and testing:** Validate legacy releases, actual browser behavior, and interrupted deployments.

## Final Acceptance Criteria

The implementation is complete when:

- Flutter's `--web-content-hash` handles asset filename generation and runtime resolution.
- Unchanged logical assets have stable URLs across releases.
- Changed assets receive new URLs without overwriting old content.
- The shared `assets/` directory contains no unnecessary duplicate copies of the same logical hashed file.
- Each release remains independently loadable while retained.
- Automatic cleanup removes only expired code and safely unreferenced assets.
- Returning browsers recover from expired releases.
- Existing manual deployments and legacy releases remain supported.
- No custom Flutter asset loader or duplicate asset-mapping system is required.

**Central rule:** Flutter owns asset naming and runtime resolution; the resilient bootstrap package owns packaging, shared storage, deployment safety, retention, and recovery.