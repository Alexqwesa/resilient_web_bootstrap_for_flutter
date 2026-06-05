import 'dart:collection';
import 'dart:convert';
import 'dart:io';

import 'package:args/args.dart';
import 'package:path/path.dart' as p;

import 'config.dart';
import 'hashing.dart';
import 'templates.dart';

String _normalizeStateKey(String relativePath) {
  return relativePath.replaceAll(r'\', '/');
}

String _stateKeyToOsPath(String stateKey) {
  final normalized = _normalizeStateKey(stateKey);
  return p.joinAll(p.posix.split(normalized));
}

final class ResilientBootstrapCli {
  Future<void> run(List<String> arguments) async {
    final parser = _buildParser();
    late ArgResults results;
    try {
      results = parser.parse(arguments);
    } on FormatException catch (error) {
      stderr.writeln(error.message);
      stdout.writeln(parser.usage);
      exitCode = 64;
      return;
    }

    if (results['help'] == true || results.command == null) {
      stdout.writeln(parser.usage);
      return;
    }

    final projectRoot = Directory(
      p.normalize(p.absolute(results['project'] as String)),
    );

    try {
      switch (results.command!.name) {
        case 'install':
          await InstallCommand(projectRoot, results.command!).run();
        case 'uninstall':
          await UninstallCommand(projectRoot, results.command!).run();
        case 'package':
          await PackageCommand(projectRoot, results.command!).run();
        case 'doctor':
          await DoctorCommand(projectRoot, results.command!).run();
        default:
          throw StateError('Unknown command: ${results.command!.name}');
      }
    } on Object catch (error) {
      stderr.writeln('resilient_bootstrap: $error');
      exitCode = 1;
    }
  }

  ArgParser _buildParser() {
    final parser = ArgParser()
      ..addFlag('help', abbr: 'h', negatable: false, help: 'Show help.')
      ..addOption('project', defaultsTo: '.', help: 'Flutter project root.');

    parser.addCommand(
      'install',
      ArgParser()..addFlag(
        'force',
        negatable: false,
        help:
            'Overwrite managed files even if they were edited since the last install.',
      ),
    );
    parser.addCommand(
      'uninstall',
      ArgParser()..addFlag(
        'restore-backup',
        negatable: false,
        help: 'Restore the newest install backup after removing managed files.',
      ),
    );
    parser.addCommand(
      'package',
      ArgParser()
        ..addOption(
          'build-dir',
          defaultsTo: p.join('build', 'web'),
          help: 'Directory produced by `flutter build web`.',
        )
        ..addOption(
          'out',
          defaultsTo: p.join('build', 'web_hardened'),
          help: 'Output directory for the packaged web app.',
        )
        ..addOption(
          'version',
          help: 'Build/version id. Defaults to local yyyyMMddHHmmss.',
        )
        ..addFlag(
          'hard-update',
          negatable: false,
          help: 'Set hardUpdate=true in latest.json.',
        )
        ..addFlag(
          'force',
          negatable: false,
          help: 'Delete the output directory first if it already exists.',
        ),
    );
    parser.addCommand('doctor', ArgParser());
    return parser;
  }
}

abstract base class ProjectCommand {
  ProjectCommand(this.projectRoot, this.results);

  final Directory projectRoot;
  final ArgResults results;

  Directory get webDir => Directory(p.join(projectRoot.path, 'web'));

  Directory get stateDir =>
      Directory(p.join(projectRoot.path, '.resilient_web_bootstrap'));

  File get stateFile => File(p.join(stateDir.path, 'installed.json'));

  void ensureFlutterProject() {
    final pubspec = File(p.join(projectRoot.path, 'pubspec.yaml'));
    if (!pubspec.existsSync()) {
      throw StateError('No pubspec.yaml found at ${projectRoot.path}');
    }
    final text = pubspec.readAsStringSync();
    if (!text.contains(RegExp(r'^flutter:\s*$', multiLine: true))) {
      throw StateError('pubspec.yaml does not look like a Flutter project.');
    }
  }

  BootstrapConfig loadConfig() => BootstrapConfig.load(projectRoot);

  Map<String, String> loadState() {
    if (!stateFile.existsSync()) {
      return {};
    }
    final decoded = jsonDecode(stateFile.readAsStringSync());
    if (decoded is! Map || decoded['files'] is! Map) {
      throw FormatException('Invalid state file: ${stateFile.path}');
    }

    final merged = <String, ({String hash, bool fromPosixKey})>{};
    for (final entry in (decoded['files'] as Map).entries) {
      final rawKey = entry.key.toString();
      final rawValue = entry.value.toString();
      final normalizedKey = _normalizeStateKey(rawKey);
      final fromPosixKey = !rawKey.contains(r'\');

      final existing = merged[normalizedKey];
      if (existing == null || (fromPosixKey && !existing.fromPosixKey)) {
        merged[normalizedKey] = (hash: rawValue, fromPosixKey: fromPosixKey);
      }
    }

    return merged.map((key, value) => MapEntry(key, value.hash));
  }

  void saveState(Map<String, String> files) {
    stateDir.createSync(recursive: true);
    const encoder = JsonEncoder.withIndent('  ');

    final normalized = SplayTreeMap<String, String>();
    for (final entry in files.entries) {
      normalized[_normalizeStateKey(entry.key)] = entry.value;
    }

    stateFile.writeAsStringSync(
      encoder.convert({'version': 1, 'files': normalized}),
    );
  }
}

final class InstallCommand extends ProjectCommand {
  InstallCommand(super.projectRoot, super.results);

  Future<void> run() async {
    ensureFlutterProject();
    final config = loadConfig();
    _ensureDefaultConfig(config);
    webDir.createSync(recursive: true);

    final force = results['force'] == true;
    final previousState = loadState();
    final nextState = Map<String, String>.from(previousState);
    final backupDir = Directory(
      p.join(stateDir.path, 'backups', _timestamp(DateTime.now())),
    );
    var backedUpAnyFile = false;

    for (final fileName in installedTemplateFiles) {
      final relativePath = p.posix.join('web', fileName);
      final destination = File(
        p.join(projectRoot.path, _stateKeyToOsPath(relativePath)),
      );
      final template = await readTemplate(fileName);
      final desired = renderTemplate(template, config);
      final desiredHash = sha256Text(desired);

      if (destination.existsSync()) {
        final currentHash = sha256File(destination);
        final previousHash = previousState[relativePath];
        if (!force && previousHash != null && currentHash != previousHash) {
          throw StateError(
            '$relativePath was edited since the last install. '
            'Re-run with --force to overwrite it.',
          );
        }
        if (currentHash != desiredHash) {
          _copyFile(
            destination,
            File(p.join(backupDir.path, _stateKeyToOsPath(relativePath))),
          );
          backedUpAnyFile = true;
        }
      }

      destination.parent.createSync(recursive: true);
      destination.writeAsStringSync(desired);
      nextState[relativePath] = desiredHash;
    }

    for (final script in _buildScripts()) {
      final relativePath = _normalizeStateKey(script.relativePath);
      final destination = File(
        p.join(projectRoot.path, _stateKeyToOsPath(relativePath)),
      );
      final desiredHash = sha256Text(script.content);

      if (destination.existsSync()) {
        final currentHash = sha256File(destination);
        final previousHash = previousState[relativePath];
        if (!force && previousHash != null && currentHash != previousHash) {
          throw StateError(
            '$relativePath was edited since the last install. '
            'Re-run with --force to overwrite it.',
          );
        }
        if (currentHash != desiredHash) {
          _copyFile(
            destination,
            File(p.join(backupDir.path, _stateKeyToOsPath(relativePath))),
          );
          backedUpAnyFile = true;
        }
      }

      destination.parent.createSync(recursive: true);
      destination.writeAsStringSync(script.content);
      nextState[relativePath] = desiredHash;
    }

    saveState(nextState);
    stdout.writeln(
      'Installed hardened Flutter web bootstrap into ${webDir.path}',
    );
    if (backedUpAnyFile) {
      stdout.writeln('Backup written to ${backupDir.path}');
    }
  }

  void _ensureDefaultConfig(BootstrapConfig config) {
    final file = File(p.join(projectRoot.path, 'resilient_bootstrap.yaml'));
    if (!file.existsSync()) {
      file.writeAsStringSync(config.toYaml());
    }
  }

  List<_ManagedScript> _buildScripts() {
    return const [
      _ManagedScript(
        relativePath: 'tool/build_resilient_web.ps1',
        content: _powerShellBuildScript,
      ),
      _ManagedScript(
        relativePath: 'tool/build_resilient_web.sh',
        content: _shellBuildScript,
      ),
    ];
  }
}

final class UninstallCommand extends ProjectCommand {
  UninstallCommand(super.projectRoot, super.results);

  Future<void> run() async {
    final state = loadState();
    if (state.isEmpty) {
      stdout.writeln('No managed bootstrap state found.');
      return;
    }

    for (final entry in state.entries) {
      final file = File(p.join(projectRoot.path, _stateKeyToOsPath(entry.key)));
      if (!file.existsSync()) {
        continue;
      }

      final currentHash = sha256File(file);
      if (currentHash == entry.value) {
        file.deleteSync();
        stdout.writeln('Removed ${entry.key}');
      } else {
        stdout.writeln('Left edited file in place: ${entry.key}');
      }
    }

    if (results['restore-backup'] == true) {
      final backup = _newestBackup();
      if (backup == null) {
        stdout.writeln('No backup found to restore.');
      } else {
        _copyDirectory(backup, projectRoot, overwrite: true);
        stdout.writeln('Restored backup from ${backup.path}');
      }
    }

    stateFile.deleteSync();
    stdout.writeln('Uninstalled managed bootstrap files.');
  }

  Directory? _newestBackup() {
    final backups = Directory(p.join(stateDir.path, 'backups'));
    if (!backups.existsSync()) {
      return null;
    }
    final dirs = backups.listSync().whereType<Directory>().toList()
      ..sort((a, b) => b.path.compareTo(a.path));
    return dirs.isEmpty ? null : dirs.first;
  }
}

final class DoctorCommand extends ProjectCommand {
  DoctorCommand(super.projectRoot, super.results);

  Future<void> run() async {
    ensureFlutterProject();
    final missing = <String>[];
    for (final fileName in installedTemplateFiles) {
      final file = File(p.join(webDir.path, fileName));
      if (!file.existsSync()) {
        missing.add('web/$fileName');
      }
    }

    if (missing.isEmpty) {
      stdout.writeln('OK: managed web bootstrap files are present.');
    } else {
      stdout.writeln('Missing managed files: ${missing.join(', ')}');
    }

    final buildDir = Directory(p.join(projectRoot.path, 'build', 'web'));
    if (buildDir.existsSync()) {
      stdout.writeln('OK: ${buildDir.path} exists.');
    } else {
      stdout.writeln(
        'Build output not found. Run `flutter build web` before packaging.',
      );
    }

    stdout.writeln('Server requirements:');
    stdout.writeln('- /index.html and /latest.json: no-cache or no-store');
    stdout.writeln('- /version/: immutable caching and byte-range support');
    stdout.writeln(
      '- Do not gzip already-created .gz files at the server layer',
    );
  }
}

final class PackageCommand extends ProjectCommand {
  PackageCommand(super.projectRoot, super.results);

  static final _bootFilePatterns = <RegExp>[
    RegExp(r'^app_update\.js$'),
    RegExp(r'^flutter_bootstrap\.js$'),
    RegExp(r'^main\.dart\.(js|mjs)$'),
    RegExp(r'^main_module\.bootstrap\.js$'),
    RegExp(r'^canvaskit/(chromium/)?canvaskit\.(js|wasm)$'),
    RegExp(r'^assets/(AssetManifest|FontManifest)\.(bin|json)$'),
  ];

  Future<void> run() async {
    ensureFlutterProject();
    final config = loadConfig();
    final version =
        (results['version'] as String?) ?? _timestamp(DateTime.now());
    final buildDir = Directory(_projectPath(results['build-dir'] as String));
    final outRoot = Directory(_projectPath(results['out'] as String));
    final versionRootName = config.versionPath.replaceAll(
      RegExp(r'^/+|/+$'),
      '',
    );
    final versionDir = Directory(
      p.join(outRoot.path, versionRootName, version),
    );
    final force = results['force'] == true;

    if (!buildDir.existsSync()) {
      throw StateError('Build directory does not exist: ${buildDir.path}');
    }
    if (_samePath(buildDir, outRoot)) {
      throw StateError('Use a different --out directory than --build-dir.');
    }
    if (outRoot.existsSync()) {
      if (!force) {
        throw StateError(
          '${outRoot.path} already exists. Re-run with --force to replace it.',
        );
      }
      outRoot.deleteSync(recursive: true);
    }

    versionDir.createSync(recursive: true);
    _copyDirectory(buildDir, versionDir, overwrite: true);
    await _copyRuntimeOverlay(config, versionDir);
    _gzipBootFiles(versionDir);

    final manifest = _buildManifest(
      config: config,
      version: version,
      versionDir: versionDir,
      hardUpdate: results['hard-update'] == true || config.hardUpdate,
    );

    _writeManifest(manifest, File(p.join(outRoot.path, 'latest.json')));
    _writeManifest(manifest, File(p.join(versionDir.path, 'latest.json')));
    await _writeIndexShell(config, version, outRoot, versionDir);

    stdout.writeln('Packaged hardened Flutter web app.');
    stdout.writeln('Output: ${outRoot.path}');
    stdout.writeln('Versioned app: ${versionDir.path}');
  }

  String _projectPath(String value) {
    return p.normalize(
      p.isAbsolute(value) ? value : p.join(projectRoot.path, value),
    );
  }

  Future<void> _copyRuntimeOverlay(
    BootstrapConfig config,
    Directory versionDir,
  ) async {
    for (final fileName in runtimeTemplateFiles) {
      final projectFile = File(p.join(webDir.path, fileName));
      final destination = File(p.join(versionDir.path, fileName));
      if (projectFile.existsSync()) {
        _copyFile(projectFile, destination);
      } else {
        final template = await readTemplate(fileName);
        destination.writeAsStringSync(renderTemplate(template, config));
      }
    }
  }

  void _gzipBootFiles(Directory versionDir) {
    for (final file in _bootFiles(versionDir)) {
      final gzFile = File('${file.path}.gz');
      gzFile.writeAsBytesSync(gzip.encode(file.readAsBytesSync()));
    }
  }

  Map<String, Object?> _buildManifest({
    required BootstrapConfig config,
    required String version,
    required Directory versionDir,
    required bool hardUpdate,
  }) {
    final files = _bootFiles(versionDir).map((file) {
      final relativePath = _relativeWebPath(versionDir, file);
      final gzFile = File('${file.path}.gz');
      final item = <String, Object?>{
        'path': relativePath,
        'size': file.lengthSync(),
        'sha256': sha256File(file),
      };
      if (gzFile.existsSync()) {
        item['gzPath'] = '$relativePath.gz';
        item['gzSize'] = gzFile.lengthSync();
        item['gzSha256'] = sha256File(gzFile);
      }
      return item;
    }).toList();

    final manifest = <String, Object?>{
      'version': version,
      'base': '${config.versionPath.replaceAll(RegExp(r'/+$'), '')}/$version/',
      'files': files,
    };
    if (hardUpdate) {
      manifest['hardUpdate'] = true;
    }
    return manifest;
  }

  void _writeManifest(Map<String, Object?> manifest, File file) {
    file.parent.createSync(recursive: true);
    const encoder = JsonEncoder.withIndent('  ');
    file.writeAsStringSync(encoder.convert(manifest));
  }

  Future<void> _writeIndexShell(
    BootstrapConfig config,
    String version,
    Directory outRoot,
    Directory versionDir,
  ) async {
    final source = File(p.join(webDir.path, 'index.html'));
    final template = source.existsSync()
        ? source.readAsStringSync()
        : await readTemplate('index.html');
    final rendered = renderTemplate(
      template.replaceAll(r'$FLUTTER_BASE_HREF', '/'),
      config,
      buildVersion: version,
    );
    File(p.join(outRoot.path, 'index.html')).writeAsStringSync(rendered);
    File(p.join(versionDir.path, 'index.html')).writeAsStringSync(rendered);
  }

  List<File> _bootFiles(Directory versionDir) {
    final files = versionDir.listSync(recursive: true).whereType<File>().where((
      file,
    ) {
      final relativePath = _relativeWebPath(versionDir, file);
      if (relativePath.endsWith('.gz')) {
        return false;
      }
      if (relativePath.split('/').any((part) => part.startsWith('.'))) {
        return false;
      }
      return _bootFilePatterns.any((pattern) => pattern.hasMatch(relativePath));
    }).toList()..sort((a, b) => a.path.compareTo(b.path));
    return files;
  }
}

void _copyFile(File source, File destination) {
  destination.parent.createSync(recursive: true);
  source.copySync(destination.path);
}

void _copyDirectory(
  Directory source,
  Directory destination, {
  required bool overwrite,
}) {
  destination.createSync(recursive: true);
  for (final entity in source.listSync(recursive: true)) {
    final relativePath = p.relative(entity.path, from: source.path);
    final targetPath = p.join(destination.path, relativePath);
    if (entity is Directory) {
      Directory(targetPath).createSync(recursive: true);
      continue;
    }
    if (entity is File) {
      final target = File(targetPath);
      if (target.existsSync() && !overwrite) {
        throw StateError('Refusing to overwrite ${target.path}');
      }
      _copyFile(entity, target);
    }
  }
}

String _relativeWebPath(Directory root, File file) {
  return p.relative(file.path, from: root.path).replaceAll(r'\', '/');
}

String _timestamp(DateTime value) {
  String two(int number) => number.toString().padLeft(2, '0');
  return '${value.year}${two(value.month)}${two(value.day)}'
      '${two(value.hour)}${two(value.minute)}${two(value.second)}';
}

bool _samePath(FileSystemEntity left, FileSystemEntity right) {
  final leftPath = p.normalize(p.absolute(left.path));
  final rightPath = p.normalize(p.absolute(right.path));
  if (Platform.isWindows) {
    return leftPath.toLowerCase() == rightPath.toLowerCase();
  }
  return leftPath == rightPath;
}

final class _ManagedScript {
  const _ManagedScript({required this.relativePath, required this.content});

  final String relativePath;
  final String content;
}

const _powerShellBuildScript = r'''
$ErrorActionPreference = "Stop"

$hardUpdate = $false
$version = $null
$flutterArgs = @("--release")
$packageArgs = @("--force")

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]
    switch ($arg) {
        "--hard-update" {
            $hardUpdate = $true
        }
        "--version" {
            if ($i + 1 -ge $args.Count) {
                throw "--version requires a value"
            }
            $i++
            $version = $args[$i]
        }
        "--profile" {
            $flutterArgs = @("--profile")
        }
        "--debug" {
            $flutterArgs = @("--debug")
        }
        "--out" {
            if ($i + 1 -ge $args.Count) {
                throw "--out requires a value"
            }
            $i++
            $packageArgs += @("--out", $args[$i])
        }
        "--build-dir" {
            if ($i + 1 -ge $args.Count) {
                throw "--build-dir requires a value"
            }
            $i++
            $packageArgs += @("--build-dir", $args[$i])
        }
        default {
            $flutterArgs += $arg
        }
    }
}

if (-not $version) {
    $version = Get-Date -Format "yyyyMMddHHmmss"
}

Write-Host "Building Flutter web..."
flutter build web @flutterArgs

$packageArgs += @("--version", $version)
if ($hardUpdate) {
    $packageArgs += "--hard-update"
}

Write-Host "Packaging hardened web build version $version..."
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . package @packageArgs
''';

const _shellBuildScript = r'''
#!/usr/bin/env sh
set -eu

hard_update=0
version=""
flutter_args="--release"
package_args="--force"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hard-update)
      hard_update=1
      shift
      ;;
    --version)
      if [ "$#" -lt 2 ]; then
        echo "--version requires a value" >&2
        exit 64
      fi
      version="$2"
      shift 2
      ;;
    --profile)
      flutter_args="--profile"
      shift
      ;;
    --debug)
      flutter_args="--debug"
      shift
      ;;
    --out)
      if [ "$#" -lt 2 ]; then
        echo "--out requires a value" >&2
        exit 64
      fi
      package_args="$package_args --out $2"
      shift 2
      ;;
    --build-dir)
      if [ "$#" -lt 2 ]; then
        echo "--build-dir requires a value" >&2
        exit 64
      fi
      package_args="$package_args --build-dir $2"
      shift 2
      ;;
    *)
      flutter_args="$flutter_args $1"
      shift
      ;;
  esac
done

if [ -z "$version" ]; then
  version="$(date +%Y%m%d%H%M%S)"
fi

echo "Building Flutter web..."
flutter build web $flutter_args

if [ "$hard_update" -eq 1 ]; then
  package_args="$package_args --hard-update"
fi

echo "Packaging hardened web build version $version..."
dart run resilient_web_bootstrap_for_flutter:resilient_bootstrap --project . package $package_args --version "$version"
''';
