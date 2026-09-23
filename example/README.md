# Example

Install the hardened Flutter web bootstrap in an app, then package
`flutter build web` into a versioned directory you can deploy.

## Add the package

```yaml
dev_dependencies:
  resilient_web_bootstrap_for_flutter: ^0.1.1
```

## Install managed `web/` files

From the Flutter project root:

```bash
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . install
```

`install` writes the bootstrap files under `web/` and creates
`resilient_bootstrap.yaml` when that file is missing:

```yaml
app:
  title: "Flutter App"
  description: "Hardened Flutter web app"
  loaderLabel: "Loading"

bootstrap:
  versionPath: "/version"
  hardUpdate: false
  cleanupPage: "cleanup_cache.html"
```

Run `install` again after you change template fields such as the title or
loader label.

## Build and package

```bash
flutter build web --release
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . package --force
```

Deploy `build/web_hardened`, not the raw `build/web` directory. The packaged
tree keeps each release under `version/<build>/` and leaves root `index.html`
and `latest.json` uncached so a new deploy does not mix files from two builds.

`install` also writes `tool/build_resilient_web.sh` and
`tool/build_resilient_web.ps1`, which run the Flutter build and the package
step together:

```bash
sh tool/build_resilient_web.sh
```

```powershell
.\tool\build_resilient_web.ps1
```
