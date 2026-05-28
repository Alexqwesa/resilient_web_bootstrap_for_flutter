import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';

void main() {
  test('install writes generic managed web files and state', () async {
    final project = await _createFlutterProject();
    addTearDown(() => project.deleteSync(recursive: true));

    final result = await _runCli(project, ['install']);
    expect(result.exitCode, 0, reason: result.stderr.toString());

    final index = File(
      p.join(project.path, 'web', 'index.html'),
    ).readAsStringSync();
    expect(index, contains('Flutter App'));
    expect(index, contains('flutter-bootstrap-token'));
    expect(index, isNot(contains('vsp')));
    expect(index, isNot(contains('svodka')));

    expect(
      File(p.join(project.path, 'resilient_bootstrap.yaml')).existsSync(),
      isTrue,
    );
    expect(
      File(
        p.join(project.path, '.resilient_web_bootstrap', 'installed.json'),
      ).existsSync(),
      isTrue,
    );
  });

  test('package creates versioned output and manifest hashes', () async {
    final project = await _createFlutterProject();
    addTearDown(() => project.deleteSync(recursive: true));

    var result = await _runCli(project, ['install']);
    expect(result.exitCode, 0, reason: result.stderr.toString());

    _writeBuildOutput(project);
    result = await _runCli(project, [
      'package',
      '--version',
      '202605281200',
      '--force',
    ]);
    expect(result.exitCode, 0, reason: result.stderr.toString());

    final out = Directory(p.join(project.path, 'build', 'web_hardened'));
    final versionDir = Directory(p.join(out.path, 'version', '202605281200'));
    expect(File(p.join(out.path, 'index.html')).existsSync(), isTrue);
    expect(File(p.join(out.path, 'latest.json')).existsSync(), isTrue);
    expect(
      File(p.join(versionDir.path, 'main.dart.js.gz')).existsSync(),
      isTrue,
    );
    expect(
      File(p.join(versionDir.path, 'flutter_bootstrap.js.gz')).existsSync(),
      isTrue,
    );

    final manifest =
        jsonDecode(File(p.join(out.path, 'latest.json')).readAsStringSync())
            as Map;
    expect(manifest['version'], '202605281200');
    expect(manifest['base'], '/version/202605281200/');

    final files = (manifest['files'] as List).cast<Map>();
    final main = files.singleWhere((file) => file['path'] == 'main.dart.js');
    expect(main['gzPath'], 'main.dart.js.gz');
    expect(
      main['gzSize'],
      isA<int>().having((value) => value, 'value', greaterThan(0)),
    );
    expect(
      main['gzSha256'],
      isA<String>().having((value) => value.length, 'length', 64),
    );
  });
}

Future<Directory> _createFlutterProject() async {
  final project = await Directory.systemTemp.createTemp(
    'resilient_bootstrap_test_',
  );
  File(p.join(project.path, 'pubspec.yaml')).writeAsStringSync('''
name: fixture_app
environment:
  sdk: ">=3.10.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
flutter:
  uses-material-design: true
''');
  return project;
}

Future<ProcessResult> _runCli(Directory project, List<String> args) {
  return Process.run(Platform.resolvedExecutable, [
    'run',
    'bin/resilient_bootstrap.dart',
    '--project',
    project.path,
    ...args,
  ], workingDirectory: Directory.current.path);
}

void _writeBuildOutput(Directory project) {
  final root = Directory(p.join(project.path, 'build', 'web'))
    ..createSync(recursive: true);
  File(
    p.join(root.path, 'flutter_bootstrap.js'),
  ).writeAsStringSync('console.log("boot");');
  File(
    p.join(root.path, 'main.dart.js'),
  ).writeAsStringSync('console.log("main");');
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
