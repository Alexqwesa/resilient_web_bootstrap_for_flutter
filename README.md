# resilient_web_bootstrap_for_flutter

**Make Flutter Web survive bad networks, stale caches, and risky deploys.**

A resilient, version-aware bootstrap and deployment layer for Flutter Web.

Flutter Web’s default bootstrap works well under ideal conditions. In real
deployments, however, large boot assets may stall, users may load an application
while a new release is being deployed, and browser or service-worker caches may
retain an incompatible mixture of old and new files.

`resilient_web_bootstrap_for_flutter` adds a controlled boot process designed
for unreliable networks and safe production updates.

It packages every Flutter Web build as an immutable, versioned release and
loads it through a small uncached entry point. Large boot files can be
downloaded as compressed, resumable assets and verified with SHA-256 before
they are used. The currently running application can remain available while
the next release downloads in the background, and built-in recovery pages help
repair broken loader, browser, or service-worker cache state.

Use it when “refresh and try again” is not an acceptable recovery strategy:
internal portals, offshore and remote sites, kiosks, iframe applications,
operations dashboards, and other long-running Flutter Web applications.

**Highlights**
- Immutable, versioned releases under /version/<build>/
- Safe deployment without mixing files from different releases
- Resumable downloads for large Flutter boot assets
- Pre-compressed main.dart.js and CanvasKit files
- SHA-256 integrity verification
- Background release downloads
- Optional forced clean updates
- Cache-repair and cleanup pages
- Dart CLI for installation, validation, and build packaging

## Requirements

- **Flutter 3.50+** for the default production workflow. Release builds use
  Flutter's native `--web-content-hash`, which older SDKs do not have; the build
  stops with an explicit error on an older SDK.
- Older Flutter SDKs work only in legacy mode (`--no-web-content-hash`): assets stay
  inside each release directory and are not shared between releases.
- Cleanup and deploy helpers need only Dart (or a compiled executable), not Flutter.

## Tradeoffs

| Choice | Why it helps                                                                                           | What you need to know                                                    |
|---|--------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| **Resumable boot files** | Bad connections do not force huge files to restart from zero.                                          | Your server must support byte-range requests for `/version/` files.      |
| **Gzip transfer** | Boot files are smaller on the wire. For example, standard flutter deploy shrink from 15Mb to just 5Mb. | The browser must decompress the file before running it.                  |
| **Versioned deploys** | Old sessions and new sessions can both keep working during a deploy.                                   | Cache headers must be configured correctly.                              |
| **Background sideload** | Users can keep working while the next version downloads.                                               | Use --hard-update to load latest version (like in usuall deploys)        |
| **Safer boot path** | Progress, retry, resume, and validation are visible and controlled.                                    | On excellent networks, native Flutter loading may start slightly faster. |

## How It Works

The package installs hardened bootstrap files into `web/`.

Then it post-processes `flutter build web` output into a versioned layout:

```text
index.html
latest.json
status.json       # optional ops messages; copied through when present in build/web
robots.txt        # copied through when present in build/web
sitemap.xml       # copied through when present in build/web
version/<build>/
  index.html
  latest.json
  flutter_bootstrap.js
  flutter_bootstrap.js.gz
  main.dart.js
  main.dart.js.gz
  canvaskit/
  assets/
```

The loader supports versioned boot assets, resumable gzip downloads, manifest integrity
checks, background sideload updates, cache repair, and a cleanup page.

## Recommended Usage

Add the package as a dev dependency:

```yaml
dev_dependencies:
  resilient_web_bootstrap_for_flutter: ^0.1.0
```

Or from git:

```yaml
dev_dependencies:
  resilient_web_bootstrap_for_flutter:
    git:
      url: https://github.com/Alexqwesa/resilient_web_bootstrap_for_flutter
```

Install or update the managed `web/` files:

```bash
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . install
```

This also creates build helper scripts:

- `tool/build_resilient_web.ps1`
- `tool/build_resilient_web.sh`

Build and package the web app with an auto-generated local timestamp version:

```powershell
.\tool\build_resilient_web.ps1
.\tool\build_resilient_web.ps1 --hard-update
```

```bash
sh tool/build_resilient_web.sh
sh tool/build_resilient_web.sh --hard-update
```

Or run the lower-level commands manually:

```bash
flutter build web --release
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . package --force
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . package --hard-update --force
```

The default packaged output is `build/web_hardened`. Deploy that directory, not the raw
`build/web` directory.

Legacy releases include their own complete `assets/` directory. Native content-hashed
releases use the shared root `assets/` directory. `package --force`
updates root files while preserving existing releases; duplicate version IDs
are rejected. Packaging does not automatically clean up old releases unless `--cleanup` is supplied.

Promotion should copy `version/<build>/` first and replace root `index.html` and
`latest.json` last. Configure nginx so root `index.html`, `/`, `latest.json`, and
`status.json` are not cached by nginx or the browser; immutable caching should
apply to shared hashed `/assets/` files and immutable release resources.
Pinned HTML/manifests and bundled CanvasKit resources should revalidate.

Root crawler files from the Flutter build, such as `robots.txt`, `sitemap.xml`,
and `sitemap_index.xml`, are copied to the packaged output root. They are not boot
assets and are not listed in `latest.json`. Optional root `status.json` is copied
the same way when present in `web/` / `build/web`.

## Ops status messages

Deploy a mutable root file `/status.json` (same cache rules as `latest.json`) when
you want operator-controlled boot messaging without rebuilding the Flutter app:

```json
{
  "loading": "Optional note shown on the loading screen.",
  "hold": "API is down. We are repairing it. The app will open when this clears.",
  "after": "Optional note shown in the bottom bar after the app starts."
}
```

- `loading`: shown on the early shell and CanvasKit preloader. Omit or leave empty
  for the normal loader text only.
- `hold`: non-empty value keeps the loading screen and does not start the app.
  The bootstrap rechecks `/status.json` every 20 seconds. Delete the file, or clear
  `hold`, to resume boot.
- `after`: shown after `flutter-first-frame` on the existing bottom bar (notice
  mode: text + dismiss, no progress). A real background version update replaces
  the notice.

Missing `/status.json` or a 404 is normal and means no ops messages. Values are
shown as plain text, not HTML.

## Native Content Hashing And Shared Assets

Generated build scripts use Flutter 3.50+ native `--web-content-hash` for release
builds. They check SDK compatibility before building. Use
`--no-web-content-hash` with an older SDK. Debug/profile builds keep Flutter's
normal filenames by default; `flutter run` is unchanged. Deferred-import output
is rejected with hashing enabled; use the legacy option for those builds.
All other Flutter arguments retain their original argument boundaries.

```bash
sh tool/build_resilient_web.sh --dart-define='APP_LABEL=My App'
sh tool/build_resilient_web.sh --no-web-content-hash
```

```powershell
.\tool\build_resilient_web.ps1 --web-content-hash
```

Packaging validates Flutter's `precache_manifest.json` (`version: 1`, `entries`
with `url`, `hash`, `size`, `urlHashed`). Flutter owns naming and runtime mapping.
Every physical hashed file under `assets/` is copied to the common root with
its original relative path. Identical existing files are reused after full
SHA-256 verification. A filename collision with different bytes fails packaging.
Different logical paths remain separate even when their contents match.
The compiled Flutter bootstrap and its injected build configuration are preserved.

```text
web_hardened/
  index.html
  latest.json
  assets/                         # append-only during deployment
  version/<id>/
    index.html
    latest.json                   # base for code, assetBase for Flutter assets
    asset_refs.json               # exact physical shared paths; server use only
    flutter_bootstrap.js
    <Flutter-generated entrypoints and gzip copies>
```

New manifests include UTC `createdAt`, `base`, `assetBase`, and entrypoint names.
For a subpath, set `bootstrap.basePath: "/simops/"` before `install` and build
with Flutter's `--base-href /simops/`. `bootstrap.versionPath` is relative to this
app base (default `/version`). Publish the output directory at `/simops/`.

Builds without a native inventory remain release-local and are reported as legacy.
Published old releases are never rewritten or migrated. Pinned pages load their
own manifest. Root startup recovers from a deleted remembered release only on a
proven HTTP 404/410, with a bounded retry; temporary failures retain cached state.
A release becomes last-good only after Flutter paints its first frame.

## Deployment And Retention

Packaging stages a new release before publishing root pointers and refuses
repeated release IDs even with `--force`. Existing releases and shared files
survive incremental builds. To deploy to a filesystem destination safely:

```bash
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap deploy --dest /srv/www/app
```

```powershell
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap deploy --dest C:\inetpub\wwwroot\app
```

The helper validates boot dependencies, merges immutable shared files, copies the
release, and replaces root manifest/HTML last using same-directory renames.
It does not delete destination files or implicitly run cleanup. For manual copies,
merge `assets/` first, then `version/<id>/`, then root crawler/status files and
finally `latest.json` and `index.html`. Do not use deletion-based mirrors such as
`rsync --delete` or `robocopy /MIR`. Coordinate manual copying and cleanup so they
cannot overlap. Helper commands share an exclusive `.resilient-deploy.lock`.
After an interrupted operation, inspect the deployment before removing a stale lock.

Cleanup previews by default and reports retained, deleted, and skipped paths and
byte sizes. It keeps the current root/embedded release, at least three recent
releases, releases younger than 90 days, unknown-age releases, and any explicit
rollback protection. All retained references are marked before asset sweeping.
Unreferenced files are eligible only after their modification time passes the
asset grace period. Missing/malformed retained dependency metadata blocks shared
asset deletion. Legacy whole-bundle donors are protected while referenced.
Expired legacy releases eventually expire as a unit; no migration is required.

```yaml
cleanup:
  enabled: true
  keepDays: 90
  keepReleases: 3
  assetGraceDays: 90
  collectAssets: true
```

```bash
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --keep-days 90 --dry-run
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --keep-months 2 --protect rollback-id --apply
# Disable shared asset GC while still expiring release directories:
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --no-assets --apply
```

Use `--versions releases` for a custom physical version directory.
`package --cleanup` opts into applying YAML retention after successful publication;
`cleanup.enabled: false` disables that automatic step. Explicit cleanup commands
remain available. Maintenance never depends on local build output.

For a server with neither Flutter nor Dart, compile a standalone executable on a
machine with the matching OS/architecture, and keep it outside the public root:

```bash
dart compile exe bin/resilient_cleanup.dart -o build/resilient_cleanup
./build/resilient_cleanup --root /srv/www/app --dry-run
./build/resilient_cleanup --root /srv/www/app --apply
```

On Windows use `-o build/resilient_cleanup.exe`. No Python runtime is required.
A finite retention period cannot protect an indefinitely open browser tab from
later asset requests. Extend retention/grace periods or disable asset GC for those
workloads. Preserve old deployments until returning clients have upgraded.

## Direct Version URLs

You can open a pinned build directly:

```text
/version/<build>/index.html
```

In this mode the shell treats `/version/<build>/` as the app base:

- boot scripts are loaded from the same `/version/<build>/` directory;
- initial boot reads `/version/<build>/latest.json`, not root `/latest.json`;
- background sideload checks are disabled for that page;
- `flutter.lastGoodManifest` is not overwritten by the pinned page;
- root `latest.json` and root `version.json` are not used as the boot source.
- boot Cache Storage uses one rotating pinned namespace, so opening another pinned
  build replaces only the pinned boot cache and does not touch root app boot caches.

This URL is safe to cache immutably because the build directory must never be changed
after publication. If a file in `/version/<build>/` is wrong, publish a new build id
instead of replacing files inside the old directory.

## Global Usage

For CI images or one-off local use:

```bash
dart pub global activate resilient_web_bootstrap_for_flutter
resilient_bootstrap --project . install
resilient_bootstrap --project . package --force
```

The dev-dependency workflow is preferred because the project records the tool version.

## Configuration

`install` creates `resilient_bootstrap.yaml` if it does not exist:

```yaml
app:
  title: "Flutter App"
  description: "Hardened Flutter web app"
  loaderLabel: "Loading"
  tokenMessageType: "flutter-bootstrap-token" # Useful when deploying in an iframe and passing messages to the app, such as an auth token.

bootstrap:
  versionPath: "/version"
  hardUpdate: false
  cleanupPage: "cleanup_cache.html"
```

Run `install` again after changing template fields such as title, description,
loader label, or token message type. `hardUpdate` affects packaging only.

## Commands

```bash
resilient_bootstrap --project . install [--force]
resilient_bootstrap --project . package [--build-dir build/web] [--out build/web_hardened] [--version <id>] [--hard-update] [--force]
resilient_bootstrap --project . cleanup [--root <deploy-dir>] [--dry-run | --apply]
resilient_bootstrap --project . deploy --dest <directory>
resilient_bootstrap --project . doctor
resilient_bootstrap --project . uninstall [--restore-backup]
```

`install` writes only managed bootstrap files and records their hashes in
`.resilient_web_bootstrap/installed.json`. Existing files are backed up under
`.resilient_web_bootstrap/backups/<timestamp>/`.

The generated build scripts accept:

```bash
--hard-update
--web-content-hash / --no-web-content-hash
--cleanup / --no-cleanup
--version <id>
--out <dir>
--build-dir <dir>
--profile
--debug
```

Any other argument is passed through to `flutter build web`.

`uninstall` removes only files whose current hash still matches the managed hash. Edited
files are left in place.

## Removing The Package Safely

After `install`, the generated `web/` files are ordinary project files. You can remove the
dev dependency if you do not need future updates or packaging from this tool.

To fully remove managed files:

```bash
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . uninstall --restore-backup
```

## Server Requirements

Default setup does **not** need Content-Security-Policy. Caching and byte-range support are enough:

- Serve `/index.html`, `/latest.json`, and `/status.json` with `no-cache` or `no-store`.
- Serve `/robots.txt` and sitemap files from the output root when present.
- Serve hashed `/assets/` and release code with immutable caching.
- Revalidate pinned HTML/manifests and bundled CanvasKit files.
- Return real 404s for missing assets and entrypoints; exclude them from SPA fallbacks.
- Include MIME mappings for JS/MJS, WASM, JSON, PNG, TTF, and OTF.
- Preserve byte-range support for `/version/` files.
- Do not server-gzip the generated `.gz` files again.

Example nginx shape (no CSP):

```nginx
server {
  # Other server config: listen, server_name, root, TLS, etc.

  # Include your server's standard mime.types (including mjs/wasm/font types).
  location ^~ /assets/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location ~ ^/version/[^/]+/(index\.html|latest\.json)$ {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate";
  }

  location ~ ^/version/[^/]+/canvaskit/ {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate";
  }

  location /version/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Accept-Ranges "bytes" always;
    gzip off;
    gzip_static off;
  }

  location = /index.html {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate" always;
  }

  location = /latest.json {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate" always;
  }

  location = /status.json {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate" always;
  }

  location = /robots.txt {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate" always;
  }

  location ~ ^/(sitemap|sitemap_index)\.xml$ {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate" always;
  }
}
```

## Content Security Policy (optional)

Skip this section unless your site already enforces CSP (or you want to add one).
Without a CSP header, browsers use their normal defaults and this bootstrap works as-is.

If you do send CSP, put it on **HTML documents** only (`/index.html` and pinned
`/version/<build>/index.html`). Headers on `.js`, `.json`, `.wasm`, or `.gz`
responses do not control page script policy.

This package currently needs:

- `script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'`
  - `'self'`: normal same-origin scripts
  - `blob:`: gunzipped boot scripts loaded via `URL.createObjectURL`
  - `'unsafe-inline'`: inline scripts in managed `index.html`
  - `'wasm-unsafe-eval'`: Flutter CanvasKit / WebAssembly
- `style-src 'self' 'unsafe-inline'`: inline loader styles
- `worker-src 'self' blob:`: workers that may use blob URLs
- `connect-src 'self'`: `fetch` for `latest.json`, `status.json`, and `/version/` downloads
- `img-src 'self' data:` and `font-src 'self' data:`: icons / Flutter assets

Example policy string:

```text
default-src 'self'; script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self'
```

Example nginx addition for HTML documents:

```nginx
set $resilient_bootstrap_csp "default-src 'self'; script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self'";

location = /index.html {
  try_files $uri =404;
  add_header Cache-Control "no-cache, must-revalidate" always;
  add_header Content-Security-Policy $resilient_bootstrap_csp always;
}

# Needed only if users open pinned builds as documents:
# /version/<build>/index.html
location ~ ^/version/[^/]+/index\.html$ {
  try_files $uri =404;
  add_header Cache-Control "no-cache, must-revalidate";
  add_header Content-Security-Policy $resilient_bootstrap_csp always;
}
```

In nginx, `add_header` in a `location` is not inherited from the parent when that
`location` already defines its own `add_header`. Repeat CSP next to Cache-Control
in those HTML locations. Prefer nonces/hashes over `'unsafe-inline'` if you
harden further.

## Tests

```bash
dart test
dart test test/e2e_test.dart
node --test test/app_update_boot.test.js
node --test test/boot_download_helpers.test.js
node --test test/flutter_bootstrap_helpers.test.js
node --test test/sha256_fallback.test.js
```

Chrome e2e builds two deploy trees (`before_apply`, `after_apply`), serves them with
byte-range support, and drives real Chromium through Playwright.

**Stub app** (no Flutter SDK; fake `main.dart.js`):

```bash
cd test/e2e_chrome
npm install
npx playwright install chromium
node --test e2e_chrome.test.mjs
```

**Real Flutter 3.50+ content-hashed app** (runs `flutter create` + `flutter build web` twice; slower):

```bash
cd test/e2e_chrome
npm install
npx playwright install chromium
node --test e2e_chrome_flutter.test.mjs
```

Without Flutter 3.50+, the test runs a legacy build and reports the shared-asset
check as skipped. Set `E2E_WEB_CONTENT_HASH=1` to require content hashing (fails on
older SDKs) or `E2E_WEB_CONTENT_HASH=0` to force the legacy build.
The real fixture exercises rootBundle, Image.asset, variants, native manifests,
Material fonts, and a shader.

The Flutter e2e sets `window.__E2E_FLUTTER_VERSION__` / `data-e2e-flutter` from Dart
(CanvasKit text is not in the DOM). You should see a real Flutter screen, not the
stub “E2E app …” label.

To watch the browser window (headed):

```powershell
cd test/e2e_chrome
$env:E2E_HEADED='1'; node --test e2e_chrome_flutter.test.mjs
```

Optional: `$env:E2E_SLOWMO_MS='500'` slows each action; `$env:E2E_CHROME_CHANNEL='chrome'` uses installed Google Chrome.

## Third-party

Bundled `lib/templates/web/fflate.min.js` is [fflate](https://github.com/101arrowz/fflate) 0.8.2 (MIT). See `LICENSE`.
