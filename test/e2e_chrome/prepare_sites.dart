import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// Builds two deployable site trees for Chrome e2e:
/// - sites/before_apply  → version `before_apply` only
/// - sites/after_apply   → both versions; root points at `after_apply` (hardUpdate)
Future<void> main(List<String> args) async {
  final repoRoot = Directory.current;
  final outRoot = args.isNotEmpty
      ? Directory(p.normalize(p.absolute(args.first)))
      : Directory(p.join(repoRoot.path, 'test', 'e2e_chrome', 'sites'));

  if (outRoot.existsSync()) {
    outRoot.deleteSync(recursive: true);
  }
  outRoot.createSync(recursive: true);

  final project = await Directory.systemTemp.createTemp(
    'resilient_e2e_chrome_project_',
  );
  try {
    _writeFlutterProject(project);
    await _runCli(project, ['install']);

    final beforeDir = Directory(p.join(outRoot.path, 'before_apply'));
    final afterDir = Directory(p.join(outRoot.path, 'after_apply'));
    final stagedAfter = Directory(p.join(outRoot.path, '_staged_after_apply'));

    _writeBuildOutput(project, versionId: 'before_apply');
    await _runCli(project, [
      'package',
      '--version',
      'before_apply',
      '--out',
      beforeDir.path,
      '--force',
    ]);

    _writeBuildOutput(project, versionId: 'after_apply');
    await _runCli(project, [
      'package',
      '--version',
      'after_apply',
      '--hard-update',
      '--out',
      stagedAfter.path,
      '--force',
    ]);

    _copyDirectory(beforeDir, afterDir);
    _copyDirectory(
      Directory(p.join(stagedAfter.path, 'version', 'after_apply')),
      Directory(p.join(afterDir.path, 'version', 'after_apply')),
    );
    File(
      p.join(stagedAfter.path, 'index.html'),
    ).copySync(p.join(afterDir.path, 'index.html'));
    File(
      p.join(stagedAfter.path, 'latest.json'),
    ).copySync(p.join(afterDir.path, 'latest.json'));

    stagedAfter.deleteSync(recursive: true);

    final marker = {
      'before_apply': p.join(beforeDir.path, 'latest.json'),
      'after_apply': p.join(afterDir.path, 'latest.json'),
      'beforeVersion': 'before_apply',
      'afterVersion': 'after_apply',
    };
    File(
      p.join(outRoot.path, 'manifest.json'),
    ).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(marker));

    stdout.writeln('Prepared Chrome e2e sites under ${outRoot.path}');
  } finally {
    project.deleteSync(recursive: true);
  }
}

void _writeFlutterProject(Directory project) {
  File(p.join(project.path, 'pubspec.yaml')).writeAsStringSync('''
name: e2e_chrome_fixture
environment:
  sdk: ">=3.10.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
flutter:
  uses-material-design: true
''');
}

/// Simulates `flutter build web` output:
/// - versioned stub `main.dart.js` (fires `flutter-first-frame`)
/// - hardened `web/flutter_bootstrap.js` with Flutter's `{{flutter_js}}`
///   placeholders replaced by a tiny loader stub (no Flutter SDK required)
void _writeBuildOutput(Directory project, {required String versionId}) {
  final root = Directory(p.join(project.path, 'build', 'web'))
    ..createSync(recursive: true);

  File(p.join(root.path, 'main.dart.js')).writeAsStringSync('''
(function () {
  var version = ${jsonEncode(versionId)};
  function markReady() {
    var existing = document.getElementById('e2e-app');
    if (existing) {
      existing.setAttribute('data-version', version);
      existing.textContent = 'E2E app ' + version;
    } else {
      var el = document.createElement('div');
      el.id = 'e2e-app';
      el.setAttribute('data-version', version);
      el.textContent = 'E2E app ' + version;
      document.body.appendChild(el);
    }
    window.__E2E_APP_VERSION__ = version;
    window.dispatchEvent(new Event('flutter-first-frame'));
  }
  if (document.body) {
    markReady();
  } else {
    document.addEventListener('DOMContentLoaded', markReady, { once: true });
  }
})();
''');

  final installedBootstrap = File(
    p.join(project.path, 'web', 'flutter_bootstrap.js'),
  );
  if (!installedBootstrap.existsSync()) {
    throw StateError('Missing installed web/flutter_bootstrap.js');
  }

  // Real Flutter replaces these placeholders during `flutter build web`.
  const flutterJsStub = r'''
window._flutter = window._flutter || {};
_flutter.loader = {
  load: function (options) {
    var config = (options && options.config) || {};
    var base = config.entrypointBaseUrl || '/';
    if (base.charAt(base.length - 1) !== '/') {
      base += '/';
    }
    var script = document.createElement('script');
    script.src = base + 'main.dart.js';
    script.async = false;
    (document.body || document.documentElement).appendChild(script);
    return Promise.resolve();
  }
};
''';
  const flutterBuildConfigStub = r'''
// e2e stub: ENGINE_CONFIG is already provided by resilient flutter_bootstrap.js
''';

  final bootstrap = installedBootstrap
      .readAsStringSync()
      .replaceAll('{{flutter_js}}', flutterJsStub)
      .replaceAll('{{flutter_build_config}}', flutterBuildConfigStub);
  if (bootstrap.contains('{{flutter_')) {
    throw StateError('Unreplaced Flutter placeholders remain in bootstrap');
  }
  File(p.join(root.path, 'flutter_bootstrap.js')).writeAsStringSync(bootstrap);

  File(
    p.join(root.path, 'main_module.bootstrap.js'),
  ).writeAsStringSync('console.log("module");');

  final assets = Directory(p.join(root.path, 'assets'))
    ..createSync(recursive: true);
  File(p.join(assets.path, 'AssetManifest.json')).writeAsStringSync('{}');
  File(p.join(assets.path, 'FontManifest.json')).writeAsStringSync('[]');

  final canvaskit = Directory(p.join(root.path, 'canvaskit'))
    ..createSync(recursive: true);
  File(
    p.join(canvaskit.path, 'canvaskit.js'),
  ).writeAsStringSync('console.log("ck");');
  File(
    p.join(canvaskit.path, 'canvaskit.wasm'),
  ).writeAsBytesSync(List<int>.generate(64, (i) => i));
}

Future<void> _runCli(Directory project, List<String> args) async {
  final result = await Process.run(Platform.resolvedExecutable, [
    'run',
    'bin/resilient_bootstrap.dart',
    '--project',
    project.path,
    ...args,
  ], workingDirectory: Directory.current.path);
  if (result.exitCode != 0) {
    throw StateError(
      'CLI failed (${result.exitCode}) for $args\n'
      'stdout:\n${result.stdout}\n'
      'stderr:\n${result.stderr}',
    );
  }
}

void _copyDirectory(Directory source, Directory destination) {
  destination.createSync(recursive: true);
  for (final entity in source.listSync(recursive: true)) {
    final relative = p.relative(entity.path, from: source.path);
    final targetPath = p.join(destination.path, relative);
    if (entity is Directory) {
      Directory(targetPath).createSync(recursive: true);
    } else if (entity is File) {
      File(targetPath).parent.createSync(recursive: true);
      entity.copySync(targetPath);
    }
  }
}
