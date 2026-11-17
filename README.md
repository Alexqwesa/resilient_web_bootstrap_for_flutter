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
| **Background sideload** | Users can keep working while the next version downloads.                                               | Use `--hard-update` to switch users right away, like a normal deploy.    |
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
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . package
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . package --hard-update
```

The default packaged output is `build/web_hardened`. Deploy that directory, not the raw
`build/web` directory.

Legacy releases include their own complete `assets/` directory. Native content-hashed
releases use the shared root `assets/` directory. Each `package` run adds a new
release next to the existing ones, and a release ID can't be used twice.
Packaging does not automatically clean up old releases unless `--cleanup` is supplied.

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

Since Flutter 3.50, `flutter build web --web-content-hash` adds a short content
hash to every asset filename: `logo.png` becomes something like
`logo.431ced69.png`. When a file changes, its name changes too, so browsers never
use a stale cached copy. Unchanged files keep the same name from one release to
the next.

This package uses that to store each asset once and share it between releases.

### Building

The generated build scripts turn content hashing on for release builds:

```bash
sh tool/build_resilient_web.sh --dart-define='APP_LABEL=My App'
sh tool/build_resilient_web.sh --no-web-content-hash
```

```powershell
.\tool\build_resilient_web.ps1 --web-content-hash
```

- **Release builds use content hashing by default.** The script checks your
  Flutter version first and stops with a clear message if it's older than 3.50.
- **On older Flutter, pass `--no-web-content-hash`.** Everything still works, but
  each release keeps its own copy of the assets.
- **Debug and profile builds are unchanged.** They keep Flutter's normal
  filenames, and `flutter run` works as before.
- **Apps with deferred imports need `--no-web-content-hash`.** Flutter doesn't
  support content hashing together with deferred loading.
- **Other arguments go straight to `flutter build web`**, including values that
  contain spaces.

### How the output is organized

```text
web_hardened/
  index.html
  latest.json
  assets/                  # shared by all releases; files are only ever added
  version/<id>/
    index.html
    latest.json            # where this release's code and assets live
    asset_refs.json        # shared assets this release needs (used by cleanup)
    flutter_bootstrap.js
    main.dart.<hash>.js    # plus .gz copies
```

- **One shared `assets/` folder.** New files are added and existing files are
  never overwritten. Before reusing a file that's already there, packaging checks
  that its bytes match. If they don't, packaging stops rather than break a
  release that's already live.
- **One folder per release.** `version/<id>/` holds that release's code. Its
  `asset_refs.json` lists the shared assets it needs, so cleanup knows what's
  still in use. Browsers never download this file.
- **Checked against Flutter's own file list.** Packaging reads Flutter's
  `precache_manifest.json` and stops if any asset is missing, unlisted, or has
  the wrong size or hash.

### Hosting under a subpath

If the app lives at, for example, `https://example.com/test-site/`:

1. Set `bootstrap.basePath: "/test-site/"` in `resilient_bootstrap.yaml`, then run
   `install`.
2. Build with `--base-href /test-site/`.
3. Publish the output folder at `/test-site/`.

`bootstrap.versionPath` (default `/version`) is relative to that path.

### Older releases and returning visitors

- **Releases built without content hashing keep working.** Their assets stay in
  their own folder. Existing releases are never migrated or rewritten.
- **Pinned URLs such as `/version/<id>/index.html`** load their own release and
  assets.
- **Visitors whose saved release was deleted move to the current release
  automatically.** This only happens when the server answers 404 or 410, and the
  page reloads at most once per published version. A flaky connection never
  throws away the cached release.
- **A release becomes the fallback only after it works.** It's remembered as
  "last known good" only after Flutter draws its first frame.

### What this package does not try to do

The goal is to keep deployment simple and reliable without replacing Flutter's
built-in asset handling.

- **No custom asset loading or renaming.** Flutter already handles asset names,
  hashes, and loading. We reuse its system rather than build another one.
- **No complex deduplication.** Files with the same Flutter-generated path can be
  shared across releases. We don't compare entire builds or merge identical files
  with different names.
- **No asset database.** Each release records which assets it needs, so cleanup
  works without a database.
- **No additional service worker.** The existing bootstrap and browser caching
  mechanisms handle downloads and recovery.
- **No built-in remote deployment.** Deploy to a local folder or mounted network
  share. Use your preferred tools for SSH, S3, or other remote destinations.
- **No CanvasKit sharing yet.** CanvasKit files remain separate for each release
  to avoid caching problems.

In short: Flutter handles how assets are named and loaded. This package handles
safe deployment, sharing unchanged files, cleaning up old releases, and recovering
from stale browser caches.

## Deployment And Retention

### Packaging new releases

- **Each `package` run adds a release.** Older releases and shared assets stay in
  place.
- **Release IDs can't be reused.** Packaging the same ID twice is an error.
- **Nothing goes live until it's complete.** The new release is fully written and
  checked before `index.html` and `latest.json` switch to it. If anything fails,
  the site keeps serving the previous release.

### Deploying to your server

The `deploy` command copies a packaged build to a folder on this machine or on a
mounted network share:

```bash
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap deploy --dest /srv/www/app
```

```powershell
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap deploy --dest C:\inetpub\wwwroot\app
```

It works in a safe order:

1. Adds new shared assets. Existing ones are checked, never overwritten.
2. Copies the new release folder.
3. Checks that everything the release needs is in place.
4. Switches `latest.json` and `index.html` last.

It never deletes files at the destination and never runs cleanup by itself.

**Copying files yourself?** Follow the same order: `assets/`, then
`version/<id>/`, then root files such as `robots.txt`, sitemaps, and
`status.json`, and `latest.json` and `index.html` last. Don't use mirroring
options that delete files, such as `rsync --delete` or `robocopy /MIR`. They would
remove assets that older releases still need.

`package`, `deploy`, and `cleanup` take a lock file (`.resilient-deploy.lock`) so
they can't run at the same time. Manual copies don't take the lock, so don't run
cleanup while you copy. If an operation was interrupted, check the deployment
before deleting a leftover lock file.

### Cleaning up old releases

Releases and shared assets pile up over time. `cleanup` removes the ones no one
needs anymore. It only shows what it would do until you add `--apply`.

```bash
# Preview:
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --keep-days 90 --dry-run
# Delete, keeping two months of releases plus a rollback target:
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --keep-months 2 --protect rollback-id --apply
# Remove old releases but keep every shared asset:
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --no-assets --apply
```

**Always kept:**

- the current release, and the release built into the root `index.html`
- the 3 most recent releases
- releases younger than 90 days
- releases you protect with `--protect <id>`, such as a rollback target
- releases whose age can't be determined
- older releases that a kept release still loads assets from
- shared assets that any kept release uses

**Removed:**

- older releases not covered above
- shared assets that no kept release uses, but only if the file was added more
  than the asset grace period ago (90 days by default)

**When in doubt, nothing is deleted.** If any kept release has a missing or
unreadable `asset_refs.json`, cleanup leaves all shared assets alone. This
includes releases built without content hashing, so shared assets are only
cleaned up once those older releases have expired. The report lists every path
it keeps, deletes, or skips, with sizes.

Defaults come from `resilient_bootstrap.yaml`, and command-line options override
them:

```yaml
cleanup:
  enabled: true
  keepDays: 90
  keepReleases: 3
  assetGraceDays: 90
  collectAssets: true
```

- **Automatic cleanup is opt-in.** `package --cleanup` applies these settings
  after a successful package. `cleanup.enabled: false` turns that off.
- **Releases in a different folder?** If you changed `bootstrap.versionPath`,
  pass the folder name with `--versions`, for example `--versions releases`.
- **Cleanup only looks at the server.** It reads the deployed files and never
  needs your local build output.

Example:
```bash
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --keep-days 90 --dry-run
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --keep-months 2 --protect rollback-id --apply
# Disable shared asset GC while still expiring release directories:
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap cleanup --root /srv/www/app --no-assets --apply
```

### Running cleanup on a server without Dart

Compile a standalone executable on a machine with the same operating system and
CPU architecture as the server. Keep it outside the public web folder.

```bash
dart compile exe bin/resilient_cleanup.dart -o build/resilient_cleanup
./build/resilient_cleanup --root /srv/www/app --dry-run
./build/resilient_cleanup --root /srv/www/app --apply
```

On Windows, use `-o build/resilient_cleanup.exe`.

### Tabs that stay open for months

A browser tab left open for a very long time may still ask for asset files that
cleanup has already removed. If your users keep the app open like that, raise
`keepDays` and `assetGraceDays`, or turn off asset cleanup with `--no-assets` or
`collectAssets: false`.

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
resilient_bootstrap --project . package
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
  updateCheckDelaySeconds: 5
  cleanupPage: "cleanup_cache.html"
```

Run `install` again after changing template fields such as title, description,
loader label, or token message type. `hardUpdate` and `updateCheckDelaySeconds`
take effect the next time you run `package`; no reinstall is needed.

### How users get a new release

By default, a new release reaches users in the background, so nobody's work is
interrupted:

- **Open tabs check for updates shortly after start.** The check runs
  `updateCheckDelaySeconds` after the app starts (5 by default). If there is a new
  release, it downloads in the background.
- **The new release is used on the next visit.** Until then, the user keeps
  working in the version they already have.

To move everyone to a release right away, package it with `--hard-update`, or set
`hardUpdate: true`:

- **New visits load the new release immediately**, skipping the cached one.
- **Open tabs reload into the new release** as soon as their update check runs.

Use a hard update when the old version must stop being used, for example after a
breaking API change. Set `updateCheckDelaySeconds: 0` to make open tabs check
immediately.

## Commands

```bash
resilient_bootstrap --project . install [--force]
resilient_bootstrap --project . package [--build-dir build/web] [--out build/web_hardened] [--version <id>] [--hard-update]
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
