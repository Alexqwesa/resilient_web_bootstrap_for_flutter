import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// Builds real Flutter web deploy trees for Chrome e2e:
/// - sites_flutter/before_apply
/// - sites_flutter/after_apply  (both versions; root points at after_apply + hardUpdate)
Future<void> main(List<String> args) async {
  final repoRoot = _findRepoRoot();
  final outRoot = args.isNotEmpty
      ? Directory(p.normalize(p.absolute(args.first)))
      : Directory(p.join(repoRoot.path, 'test', 'e2e_chrome', 'sites_flutter'));

  final flutter = _resolveFlutter();
  if (flutter == null) {
    stderr.writeln('Flutter SDK not found on PATH. Install Flutter to run this e2e.');
    exitCode = 78; // EX_CONFIG
    return;
  }

  if (outRoot.existsSync()) {
    outRoot.deleteSync(recursive: true);
  }
  outRoot.createSync(recursive: true);

  final work = await Directory.systemTemp.createTemp('resilient_e2e_flutter_');
  try {
    final project = Directory(p.join(work.path, 'app'));
    await _createFlutterWebProject(flutter, project);
    _writeAppSources(project, repoRoot);

    await _run(flutter, ['pub', 'get'], cwd: project);
    await _runCli(project, repoRoot, ['install']);

    final beforeDir = Directory(p.join(outRoot.path, 'before_apply'));
    final afterDir = Directory(p.join(outRoot.path, 'after_apply'));
    final stagedAfter = Directory(p.join(outRoot.path, '_staged_after_apply'));

    await _buildAndPackage(
      flutter: flutter,
      project: project,
      repoRoot: repoRoot,
      version: 'before_apply',
      outDir: beforeDir,
      hardUpdate: false,
    );

    await _buildAndPackage(
      flutter: flutter,
      project: project,
      repoRoot: repoRoot,
      version: 'after_apply',
      outDir: stagedAfter,
      hardUpdate: true,
    );

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

    File(p.join(outRoot.path, 'manifest.json')).writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert({
        'kind': 'flutter',
        'beforeVersion': 'before_apply',
        'afterVersion': 'after_apply',
      }),
    );

    stdout.writeln('Prepared Flutter Chrome e2e sites under ${outRoot.path}');
  } finally {
    work.deleteSync(recursive: true);
  }
}

Directory _findRepoRoot() {
  var dir = Directory.current;
  while (true) {
    final pubspec = File(p.join(dir.path, 'pubspec.yaml'));
    if (pubspec.existsSync()) {
      final text = pubspec.readAsStringSync();
      if (text.contains('name: resilient_web_bootstrap_for_flutter')) {
        return dir;
      }
    }
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError('Could not find package root from ${Directory.current.path}');
    }
    dir = parent;
  }
}

String? _resolveFlutter() {
  final fromEnv = Platform.environment['FLUTTER_ROOT'];
  if (fromEnv != null && fromEnv.isNotEmpty) {
    final candidate = p.join(
      fromEnv,
      'bin',
      Platform.isWindows ? 'flutter.bat' : 'flutter',
    );
    if (File(candidate).existsSync()) {
      return candidate;
    }
  }

  final probe = Process.runSync(Platform.isWindows ? 'where' : 'which', [
    'flutter',
  ], runInShell: true);
  if (probe.exitCode != 0) {
    return null;
  }
  final lines = probe.stdout
      .toString()
      .split(RegExp(r'\r?\n'))
      .map((line) => line.trim())
      .where((line) => line.isNotEmpty);
  return lines.isEmpty ? null : lines.first;
}

Future<void> _createFlutterWebProject(String flutter, Directory project) async {
  project.parent.createSync(recursive: true);
  await _run(flutter, [
    'create',
    '--project-name',
    'e2e_chrome_flutter_app',
    '--platforms',
    'web',
    '--org',
    'com.example',
    project.path,
  ], cwd: Directory.current);
}

void _writeAppSources(Directory project, Directory repoRoot) {
  final fixtureMain = File(
    p.join(
      repoRoot.path,
      'test',
      'e2e_chrome',
      'fixtures',
      'flutter_app',
      'lib',
      'main.dart',
    ),
  );
  File(
    p.join(project.path, 'lib', 'main.dart'),
  ).writeAsStringSync(fixtureMain.readAsStringSync());

  final posixPath = repoRoot.path.replaceAll(r'\', '/');
  File(p.join(project.path, 'pubspec.yaml')).writeAsStringSync('''
name: e2e_chrome_flutter_app
description: Minimal Flutter web app for resilient bootstrap Chrome e2e.
publish_to: none
version: 0.1.0

environment:
  sdk: ">=3.10.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  web: ^1.1.1

dev_dependencies:
  flutter_test:
    sdk: flutter
  resilient_web_bootstrap_for_flutter:
    path: $posixPath

flutter:
  uses-material-design: true
''');
}

Future<void> _buildAndPackage({
  required String flutter,
  required Directory project,
  required Directory repoRoot,
  required String version,
  required Directory outDir,
  required bool hardUpdate,
}) async {
  await _run(flutter, [
    'build',
    'web',
    '--release',
    '--dart-define=E2E_VERSION=$version',
  ], cwd: project);

  final packageArgs = <String>[
    'package',
    '--version',
    version,
    '--out',
    outDir.path,
    '--force',
  ];
  if (hardUpdate) {
    packageArgs.add('--hard-update');
  }
  await _runCli(project, repoRoot, packageArgs);
}

Future<void> _runCli(
  Directory project,
  Directory repoRoot,
  List<String> args,
) async {
  final result = await Process.run(Platform.resolvedExecutable, [
    'run',
    'bin/resilient_bootstrap.dart',
    '--project',
    project.path,
    ...args,
  ], workingDirectory: repoRoot.path);
  if (result.exitCode != 0) {
    throw StateError(
      'CLI failed (${result.exitCode}) for $args\n'
      'stdout:\n${result.stdout}\n'
      'stderr:\n${result.stderr}',
    );
  }
}

Future<void> _run(
  String command,
  List<String> args, {
  required Directory cwd,
}) async {
  stdout.writeln('> $command ${args.join(' ')}');
  final result = await Process.run(
    command,
    args,
    workingDirectory: cwd.path,
    runInShell: Platform.isWindows,
  );
  if (result.exitCode != 0) {
    throw StateError(
      '$command ${args.join(' ')} failed (${result.exitCode})\n'
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
