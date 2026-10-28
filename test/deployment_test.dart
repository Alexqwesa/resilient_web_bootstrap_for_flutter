import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:resilient_web_bootstrap_for_flutter/src/assets.dart';
import 'package:resilient_web_bootstrap_for_flutter/src/cli.dart';
import 'package:resilient_web_bootstrap_for_flutter/src/deploy.dart';
import 'package:resilient_web_bootstrap_for_flutter/src/deploy_cleanup.dart';
import 'package:resilient_web_bootstrap_for_flutter/src/deployment_io.dart';
import 'package:resilient_web_bootstrap_for_flutter/src/hashing.dart';
import 'package:test/test.dart';

void main() {
  late Directory project;
  late Directory build;
  late Directory output;
  setUp(() {
    project = Directory.systemTemp.createTempSync('native_assets_');
    build = Directory(p.join(project.path, 'build', 'web'))
      ..createSync(recursive: true);
    output = Directory(p.join(project.path, 'build', 'web_hardened'));
    File(p.join(project.path, 'pubspec.yaml')).writeAsStringSync(
      'name: fixture\nflutter:\n  uses-material-design: true\n',
    );
    exitCode = 0;
  });
  tearDown(() async {
    exitCode = 0;
    for (var attempt = 0; ; attempt++) {
      try {
        project.deleteSync(recursive: true);
        break;
      } on FileSystemException {
        if (attempt == 20) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    }
  });

  Future<void> package(String version, {bool succeeds = true}) async {
    exitCode = 0;
    await ResilientBootstrapCli().run([
      '--project',
      project.path,
      'package',
      '--version',
      version,
      '--force',
    ]);
    expect(exitCode, succeeds ? 0 : 1);
    exitCode = 0;
  }

  test(
    'unchanged logical assets share URLs, changes coexist, distinct paths remain separate',
    () async {
      final first = nativeBuild(build, {
        'images/logo.png': 'first',
        'images/copy.png': 'first',
      });
      await package('A');
      final second = nativeBuild(build, {
        'images/logo.png': 'first',
        'images/copy.png': 'first',
      });
      await package('B');
      expect(second, first);
      expect(
        Directory(
          p.join(output.path, 'assets'),
        ).listSync(recursive: true).whereType<File>().length,
        3,
      );
      nativeBuild(build, {
        'images/logo.png': 'changed',
        'images/copy.png': 'first',
      });
      await package('C');
      expect(
        Directory(
          p.join(output.path, 'assets'),
        ).listSync(recursive: true).whereType<File>().length,
        4,
      );
      for (final id in ['A', 'B', 'C']) {
        expect(
          Directory(p.join(output.path, 'version', id, 'assets')).existsSync(),
          isFalse,
        );
        final manifest = readJson(output, 'version/$id/latest.json');
        expect(manifest['assetBase'], '/');
        expect(manifest['entrypoints'], ['main.12345678.dart.js']);
        expect(
          File(
            p.join(output.path, 'version', id, 'main.12345678.dart.js.gz'),
          ).existsSync(),
          isTrue,
        );
        final refs = readJson(output, 'version/$id/asset_refs.json');
        for (final path in refs['assets'] as List) {
          expect(safeFile(output, path as String).existsSync(), isTrue);
        }
        expect(
          File(
            p.join(output.path, 'version', id, 'flutter_bootstrap.js'),
          ).readAsStringSync(),
          contains('_flutter.buildConfig'),
        );
      }
    },
  );

  test(
    'corruption and duplicate versions fail without changing the active pointer',
    () async {
      final paths = nativeBuild(build, {'logo.png': 'original'});
      await package('A');
      final before = safeFile(output, 'latest.json').readAsStringSync();
      await package('A', succeeds: false);
      safeFile(output, paths.first).writeAsStringSync('corrupt');
      await package('B', succeeds: false);
      expect(safeFile(output, 'latest.json').readAsStringSync(), before);
      expect(
        Directory(p.join(output.path, 'version', 'B')).existsSync(),
        isFalse,
      );
      expect(safeFile(output, paths.first).readAsStringSync(), 'corrupt');
      expect(
        output.listSync().where(
          (e) => p.basename(e.path).startsWith('.staging-'),
        ),
        isEmpty,
      );
    },
  );

  test(
    'inventory validates bytes, paths and complete physical asset coverage',
    () {
      final paths = nativeBuild(build, {'logo.png': 'image'});
      expect(readHashedAssets(build), containsAll(paths));
      safeFile(build, paths.first).writeAsStringSync('wrong');
      expect(() => readHashedAssets(build), throwsStateError);
      nativeBuild(build, {'logo.png': 'image'});
      safeFile(build, 'assets/unlisted.png').writeAsStringSync('extra');
      expect(() => readHashedAssets(build), throwsStateError);
      final manifest = readJson(build, 'precache_manifest.json');
      (manifest['entries'] as List).first['url'] = '../outside';
      safeFile(
        build,
        'precache_manifest.json',
      ).writeAsStringSync(jsonEncode(manifest));
      expect(() => readHashedAssets(build), throwsFormatException);
    },
  );

  test('inventory without hashed assets is legacy; mixed hashing fails', () {
    nativeBuild(build, {'a.png': 'a', 'b.png': 'b'});
    final manifest = readJson(build, 'precache_manifest.json');
    final entries = (manifest['entries'] as List).cast<Map>();
    final file = safeFile(build, 'precache_manifest.json');
    entries.first['urlHashed'] = false;
    file.writeAsStringSync(jsonEncode(manifest));
    expect(() => readHashedAssets(build), throwsStateError);
    for (final entry in entries) {
      entry['urlHashed'] = false;
    }
    file.writeAsStringSync(jsonEncode(manifest));
    expect(readHashedAssets(build), isNull);
  });

  test('subpath and wasm filenames come from Flutter metadata', () async {
    nativeBuild(build, {'logo.png': 'image'});
    File(
      p.join(project.path, 'resilient_bootstrap.yaml'),
    ).writeAsStringSync('bootstrap:\n  basePath: /simops/\n');
    final config = {
      'builds': [
        {
          'mainWasmPath': 'app.12345678.wasm',
          'jsSupportRuntimePath': 'runtime.12345678.mjs',
        },
      ],
    };
    safeFile(
      build,
      'flutter_bootstrap.js',
    ).writeAsStringSync('_flutter.buildConfig = ${jsonEncode(config)};');
    safeFile(build, 'app.12345678.wasm').writeAsStringSync('wasm');
    safeFile(build, 'runtime.12345678.mjs').writeAsStringSync('runtime');
    await package('wasm');
    final manifest = readJson(output, 'latest.json');
    expect(manifest['base'], '/simops/version/wasm/');
    expect(manifest['assetBase'], '/simops/');
    expect(
      (manifest['files'] as List).map((e) => e['path']),
      containsAll(['app.12345678.wasm', 'runtime.12345678.mjs']),
    );
  });

  test('missing entrypoints and unprocessed templates never publish', () async {
    nativeBuild(build, {'logo.png': 'image'});
    await package('A');
    final before = safeFile(output, 'latest.json').readAsStringSync();
    safeFile(build, 'main.12345678.dart.js').deleteSync();
    await package('B', succeeds: false);
    expect(safeFile(output, 'latest.json').readAsStringSync(), before);
    safeFile(
      build,
      'flutter_bootstrap.js',
    ).writeAsStringSync('{{flutter_build_config}}');
    await package('C', succeeds: false);
    expect(safeFile(output, 'latest.json').readAsStringSync(), before);
  });

  test(
    'merge deployment preserves old releases and assets; corruption cannot activate',
    () async {
      nativeBuild(build, {'logo.png': 'image'});
      await package('A');
      final destination = Directory(p.join(project.path, 'server'));
      deployPackage(output, destination);
      nativeBuild(build, {'logo.png': 'changed'});
      await package('B');
      deployPackage(output, destination);
      expect(readJson(destination, 'latest.json')['version'], 'B');
      expect(
        safeFile(destination, 'version/A/latest.json').existsSync(),
        isTrue,
      );
      expect(
        Directory(
          p.join(destination.path, 'assets'),
        ).listSync().whereType<File>().length,
        3,
      );
      final before = safeFile(destination, 'latest.json').readAsStringSync();
      nativeBuild(build, {'logo.png': 'third'});
      await package('C');
      safeFile(
        output,
        'version/C/main.12345678.dart.js',
      ).writeAsStringSync('corrupt');
      expect(() => deployPackage(output, destination), throwsStateError);
      expect(safeFile(destination, 'latest.json').readAsStringSync(), before);
    },
  );

  test(
    'cleanup marks retained dependencies and sweeps only expired files; preview is repeatable',
    () {
      seedCleanup(output);
      final before = output.listSync(recursive: true).whereType<File>().length;
      final preview = cleanupDeployment(
        root: output,
        now: DateTime.utc(2026, 10, 28),
        keepReleases: 1,
      );
      expect(
        preview.where((e) => e.action == 'delete').map((e) => e.path),
        containsAll(['version/old', 'assets/unused.hash.png']),
      );
      expect(output.listSync(recursive: true).whereType<File>().length, before);
      cleanupDeployment(
        root: output,
        now: DateTime.utc(2026, 10, 28),
        keepReleases: 1,
        apply: true,
      );
      expect(safeFile(output, 'assets/shared.hash.png').existsSync(), isTrue);
      expect(safeFile(output, 'assets/recent.hash.png').existsSync(), isTrue);
      expect(safeFile(output, 'assets/unused.hash.png').existsSync(), isFalse);
      expect(
        safeFile(output, 'version/current/latest.json').existsSync(),
        isTrue,
      );
      expect(safeFile(output, 'unrelated.txt').existsSync(), isTrue);
      expect(
        cleanupDeployment(
          root: output,
          now: DateTime.utc(2026, 10, 28),
          keepReleases: 1,
          apply: true,
        ).where((e) => e.action == 'delete'),
        isEmpty,
      );
    },
  );

  test(
    'unknown age, protected rollback and malformed dependencies block unsafe asset GC',
    () {
      seedCleanup(output);
      safeFile(
        output,
        'version/rollback/latest.json',
      ).parent.createSync(recursive: true);
      safeFile(output, 'version/rollback/latest.json').writeAsStringSync(
        jsonEncode({
          'version': 'rollback',
          'createdAt': '2020-01-01T00:00:00Z',
        }),
      );
      cleanupDeployment(
        root: output,
        now: DateTime.utc(2026, 10, 28),
        keepReleases: 1,
        protectedVersions: {'rollback'},
        apply: true,
      );
      expect(
        safeFile(output, 'version/rollback/latest.json').existsSync(),
        isTrue,
      );
      expect(safeFile(output, 'assets/unused.hash.png').existsSync(), isTrue);
      safeFile(
        output,
        'version/unknown/latest.json',
      ).parent.createSync(recursive: true);
      safeFile(
        output,
        'version/unknown/latest.json',
      ).writeAsStringSync('{"version":"unknown"}');
      final entries = cleanupDeployment(
        root: output,
        now: DateTime.utc(2026, 10, 28),
        keepReleases: 0,
        apply: true,
      );
      expect(
        entries.any((e) => e.path == 'version/unknown' && e.action == 'retain'),
        isTrue,
      );
    },
  );

  test(
    'locks exclude packaging and cleanup; paths never escape the deployment',
    () async {
      nativeBuild(build, {'logo.png': 'image'});
      await package('A');
      final lock = DeploymentLock(output);
      try {
        await package('B', succeeds: false);
        expect(() => cleanupDeployment(root: output), throwsStateError);
      } finally {
        lock.release();
      }
      for (final path in [
        '../escape',
        '/absolute',
        r'assets\escape',
        'assets/%2e%2e/escape',
      ]) {
        expect(() => safeFile(output, path), throwsFormatException);
      }
      expect(
        () => cleanupDeployment(root: output, versionDirectory: '../escape'),
        throwsFormatException,
      );
    },
  );

  test('calendar retention clamps month ends and accepts explicit days', () {
    expect(
      retentionCutoff(DateTime.utc(2026, 3, 31), months: 1),
      DateTime.utc(2026, 2, 28),
    );
    expect(
      retentionCutoff(DateTime.utc(2026, 3, 31), months: 2),
      DateTime.utc(2026, 1, 31),
    );
    expect(
      () => retentionCutoff(DateTime.now(), days: -1),
      throwsArgumentError,
    );
  });
}

Map readJson(Directory root, String path) =>
    jsonDecode(safeFile(root, path).readAsStringSync()) as Map;

List<String> nativeBuild(Directory build, Map<String, String> logicalAssets) {
  final assets = Directory(p.join(build.path, 'assets'));
  if (assets.existsSync()) assets.deleteSync(recursive: true);
  final paths = <String>[];
  final entries = <Map<String, Object>>[];
  for (final item in {
    ...logicalAssets,
    'AssetManifest.bin.json': '{} same manifest',
  }.entries) {
    final hash = sha256Text(item.value).substring(0, 8);
    final extension = p.posix.extension(item.key);
    final stem = item.key.substring(0, item.key.length - extension.length);
    final path = 'assets/$stem.$hash$extension';
    final file = safeFile(build, path)..parent.createSync(recursive: true);
    file.writeAsStringSync(item.value);
    paths.add(path);
    entries.add({
      'url': path,
      'hash': hash,
      'size': file.lengthSync(),
      'urlHashed': true,
    });
  }
  safeFile(
    build,
    'precache_manifest.json',
  ).writeAsStringSync(jsonEncode({'version': 1, 'entries': entries}));
  safeFile(build, 'flutter_bootstrap.js').writeAsStringSync(
    '_flutter.buildConfig = ${jsonEncode({
      'builds': [
        {'mainJsPath': 'main.12345678.dart.js'},
      ],
    })};',
  );
  safeFile(
    build,
    'main.12345678.dart.js',
  ).writeAsStringSync('console.log("compiled app");');
  return paths;
}

void seedCleanup(Directory root) {
  root.createSync(recursive: true);
  safeFile(
    root,
    'latest.json',
  ).writeAsStringSync('{"version":"current","base":"/version/current/"}');
  safeFile(root, 'unrelated.txt').writeAsStringSync('keep');
  for (final id in ['old', 'current']) {
    final manifest = safeFile(root, 'version/$id/latest.json')
      ..parent.createSync(recursive: true);
    manifest.writeAsStringSync(
      jsonEncode({
        'version': id,
        'createdAt': id == 'current'
            ? '2026-10-20T00:00:00Z'
            : '2020-01-01T00:00:00Z',
      }),
    );
    safeFile(
      root,
      'version/$id/asset_refs.json',
    ).writeAsStringSync('{"version":1,"assets":["assets/shared.hash.png"]}');
  }
  for (final name in ['shared', 'unused', 'recent']) {
    final file = safeFile(root, 'assets/$name.hash.png')
      ..parent.createSync(recursive: true);
    file.writeAsStringSync('image');
    file.setLastModifiedSync(
      DateTime.utc(name == 'recent' ? 2026 : 2020, 10, 20),
    );
  }
}
