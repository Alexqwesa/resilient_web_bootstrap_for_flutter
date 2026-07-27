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

Promotion should copy `version/<build>/` first and replace root `index.html` and
`latest.json` last. Configure nginx so root `index.html`, `/`, and `latest.json`
are not cached by nginx or the browser; immutable caching should only apply under
`/version/`.

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
resilient_bootstrap --project . doctor
resilient_bootstrap --project . uninstall [--restore-backup]
```

`install` writes only managed bootstrap files and records their hashes in
`.resilient_web_bootstrap/installed.json`. Existing files are backed up under
`.resilient_web_bootstrap/backups/<timestamp>/`.

The generated build scripts accept:

```bash
--hard-update
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

- Serve `/index.html` and `/latest.json` with `no-cache` or `no-store`.
- Serve `/version/` files with immutable caching.
- Preserve byte-range support for `/version/` files.
- Do not server-gzip the generated `.gz` files again.

Example nginx shape (no CSP):

```nginx
server {
  # Other server config: listen, server_name, root, TLS, etc.

  location ^~ /version/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
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
- `connect-src 'self'`: `fetch` for `latest.json` and `/version/` downloads
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
  add_header Cache-Control "public, max-age=31536000, immutable" always;
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

**Real Flutter app** (runs `flutter create` + `flutter build web` twice; slower):

```bash
cd test/e2e_chrome
npm install
npx playwright install chromium
node --test e2e_chrome_flutter.test.mjs
```

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
