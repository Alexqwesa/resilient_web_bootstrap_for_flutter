# resilient_web_bootstrap_for_flutter

A Dart CLI package for adding a hardened Flutter web bootstrap to Flutter projects.

It installs the web bootstrap files into `web/`, then post-processes `flutter build web`
output into a versioned deployment layout:

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
  canvaskit/...
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

Build and package the web app:

```bash
flutter build web --release
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . package --version 202605281200 --force
```

The default packaged output is `build/web_hardened`. Deploy that directory, not the raw
`build/web` directory.

## Global Usage

For CI images or one-off local use:

```bash
dart pub global activate --source git <repo-url>
resilient_bootstrap --project . install
resilient_bootstrap --project . package --version 202605281200 --force
```

The dev-dependency workflow is preferred because the project records the tool version.

## Configuration

`install` creates `resilient_bootstrap.yaml` if it does not exist:

```yaml
app:
  title: "Flutter App"
  description: "Hardened Flutter web app"
  loaderLabel: "Loading"
  tokenMessageType: "flutter-bootstrap-token"

bootstrap:
  versionPath: "/version"
  hardUpdate: false
  cleanupPage: "cleanup_cache.html"
```

Run `install` again after changing this file.

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
