# resilient_web_bootstrap_for_flutter

**Make Flutter Web survive bad networks, stale caches, and risky deploys.**

Flutter Web is usually easy: deploy `index.html`, `flutter_bootstrap.js`, `main.dart.js`, and let the browser load the app.

That works well until one of these happens:

- the user has a slow or unstable connection;
- a large file like `main.dart.js` or `canvaskit.wasm` stalls halfway;
- the server is updated while someone is still loading the old app;
- the browser keeps a mix of old and new cached files;
- users are told to “press F5 and try again”.

This package adds a hardened boot layer for Flutter Web. It treats your web build as a **versioned release**, not as a loose set of files.

Use it for internal portals, offshore sites, kiosks, iframe apps, operations dashboards, and any Flutter Web app where **“reload and hope” is not acceptable**.

## What You Get

| Feature | What it means |
|---|---|
| **Versioned releases** | Every build lives under `/version/<build>/`, so old and new users do not fight over the same files. |
| **Tiny root entry** | Only `index.html` and `latest.json` stay at the root. They point to the active version. |
| **Resumable downloads** | Large boot files can continue after a stall instead of starting again from zero. |
| **Gzip boot files** | Big files such as `main.dart.js` and `canvaskit.wasm` can be transferred much smaller. |
| **SHA-256 checks** | Downloaded boot files are checked before the loader trusts them. |
| **Background updates** | The current app keeps running while the next version downloads in the background. |
| **Hard update mode** | Force old boot state to be ignored when a release must be loaded cleanly. |
| **Cache repair page** | Give users a safe way to recover from broken browser, service-worker, or loader cache state. |
| **Dart CLI** | Install web files, generate helper scripts, and package `flutter build web` output automatically. |

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
  resilient_web_bootstrap_for_flutter:
    git:
      url: <repo-url>
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
dart pub global activate --source git <repo-url>
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

- Serve `/index.html` and `/latest.json` with `no-cache` or `no-store`.
- Serve `/version/` files with immutable caching.
- Preserve byte-range support for `/version/` files.
- Do not server-gzip the generated `.gz` files again.

Example nginx shape:

```nginx
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
```

## Tests

```bash
dart test
node --test test/app_update_boot.test.js
node --test test/boot_download_helpers.test.js
node --test test/flutter_bootstrap_helpers.test.js
```
