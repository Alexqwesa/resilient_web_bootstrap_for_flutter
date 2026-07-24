import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

void main() {
  test(
    'e2e: install → package → HTTP smoke → uninstall',
    () async {
      final project = await _createFlutterProject();
      addTearDown(() {
        if (project.existsSync()) {
          project.deleteSync(recursive: true);
        }
      });

      // ── install ──────────────────────────────────────────────────────────
      var result = await _runCli(project, ['install']);
      expect(result.exitCode, 0, reason: result.stderr);

      final stateFile = File(
        p.join(project.path, '.resilient_web_bootstrap', 'installed.json'),
      );
      expect(stateFile.existsSync(), isTrue);

      final state =
          jsonDecode(stateFile.readAsStringSync()) as Map<String, dynamic>;
      final files = (state['files'] as Map).cast<String, String>();
      expect(files.keys, isNotEmpty);
      for (final key in files.keys) {
        expect(
          key.contains(r'\'),
          isFalse,
          reason: 'installed.json keys must use forward slashes: $key',
        );
        expect(File(p.join(project.path, key)).existsSync(), isTrue);
      }
      expect(files.keys, contains('web/index.html'));
      expect(files.keys, contains('tool/build_resilient_web.sh'));

      // ── doctor ───────────────────────────────────────────────────────────
      result = await _runCli(project, ['doctor']);
      expect(result.exitCode, 0, reason: result.stderr);
      expect(result.stdout.toString(), contains('OK: managed web bootstrap'));

      // ── package ──────────────────────────────────────────────────────────
      _writeBuildOutput(project);
      const version = '20260724120000';
      result = await _runCli(project, [
        'package',
        '--version',
        version,
        '--force',
      ]);
      expect(result.exitCode, 0, reason: result.stderr);

      final out = Directory(p.join(project.path, 'build', 'web_hardened'));
      final versionDir = Directory(p.join(out.path, 'version', version));
      expect(out.existsSync(), isTrue);
      expect(versionDir.existsSync(), isTrue);

      final rootIndex = File(p.join(out.path, 'index.html'));
      final rootManifestFile = File(p.join(out.path, 'latest.json'));
      final versionManifestFile = File(p.join(versionDir.path, 'latest.json'));
      expect(rootIndex.existsSync(), isTrue);
      expect(rootManifestFile.existsSync(), isTrue);
      expect(versionManifestFile.existsSync(), isTrue);

      final rootIndexText = rootIndex.readAsStringSync();
      expect(rootIndexText, contains(version));
      expect(rootIndexText, contains('boot_download_helpers.js'));
      expect(rootIndexText, contains('app_update.js'));

      for (final name in const [
        'boot_download_helpers.js',
        'app_update.js',
        'fflate.min.js',
        'sha256_fallback.js',
        'cleanup_cache.html',
        'main.dart.js',
        'main.dart.js.gz',
        'flutter_bootstrap.js',
        'flutter_bootstrap.js.gz',
      ]) {
        expect(
          File(p.join(versionDir.path, name)).existsSync(),
          isTrue,
          reason: 'missing packaged file: $name',
        );
      }

      final manifest =
          jsonDecode(rootManifestFile.readAsStringSync())
              as Map<String, dynamic>;
      expect(manifest['version'], version);
      expect(manifest['base'], '/version/$version/');
      expect(manifest.containsKey('hardUpdate'), isFalse);

      final versionManifest =
          jsonDecode(versionManifestFile.readAsStringSync()) as Map;
      expect(versionManifest['version'], version);

      final manifestFiles = (manifest['files'] as List).cast<Map>();
      expect(manifestFiles, isNotEmpty);
      for (final entry in manifestFiles) {
        final relativePath = entry['path'] as String;
        final file = File(p.join(versionDir.path, relativePath));
        expect(file.existsSync(), isTrue, reason: relativePath);
        expect(sha256.convert(file.readAsBytesSync()).toString(), entry['sha256']);
        expect(file.lengthSync(), entry['size']);

        final gzPath = entry['gzPath'] as String?;
        if (gzPath != null) {
          final gzFile = File(p.join(versionDir.path, gzPath));
          expect(gzFile.existsSync(), isTrue, reason: gzPath);
          expect(
            sha256.convert(gzFile.readAsBytesSync()).toString(),
            entry['gzSha256'],
          );
          expect(gzFile.lengthSync(), entry['gzSize']);
          expect(
            gzip.decode(gzFile.readAsBytesSync()),
            file.readAsBytesSync(),
          );
        }
      }

      // ── HTTP smoke (static + byte-range) ─────────────────────────────────
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() async {
        await server.close(force: true);
      });
      server.listen((request) => _servePackaged(out, request));

      final baseUrl = 'http://${server.address.host}:${server.port}';
      final client = HttpClient();
      addTearDown(client.close);

      final latestResponse = await _get(client, '$baseUrl/latest.json');
      expect(latestResponse.statusCode, 200);
      expect(
        latestResponse.headers.value(HttpHeaders.cacheControlHeader),
        contains('no-cache'),
      );
      final latestBody =
          jsonDecode(utf8.decode(latestResponse.body)) as Map<String, dynamic>;
      expect(latestBody['version'], version);

      final indexResponse = await _get(client, '$baseUrl/index.html');
      expect(indexResponse.statusCode, 200);
      expect(utf8.decode(indexResponse.body), contains(version));

      final mainEntry = manifestFiles.singleWhere(
        (file) => file['path'] == 'main.dart.js',
      );
      final gzUrl = '$baseUrl/version/$version/${mainEntry['gzPath']}';
      final gzResponse = await _get(client, gzUrl);
      expect(gzResponse.statusCode, 200);
      expect(
        sha256.convert(gzResponse.body).toString(),
        mainEntry['gzSha256'],
      );
      expect(
        gzResponse.headers.value(HttpHeaders.acceptRangesHeader),
        'bytes',
      );

      final fullGz = File(
        p.join(versionDir.path, mainEntry['gzPath'] as String),
      ).readAsBytesSync();
      expect(fullGz.length, greaterThan(4));
      final rangeEnd = 3;
      final rangeResponse = await _get(
        client,
        gzUrl,
        headers: {HttpHeaders.rangeHeader: 'bytes=0-$rangeEnd'},
      );
      expect(rangeResponse.statusCode, 206);
      expect(rangeResponse.body, fullGz.sublist(0, rangeEnd + 1));
      expect(
        rangeResponse.headers.value(HttpHeaders.contentRangeHeader),
        'bytes 0-$rangeEnd/${fullGz.length}',
      );

      // ── uninstall ────────────────────────────────────────────────────────
      result = await _runCli(project, ['uninstall']);
      expect(result.exitCode, 0, reason: result.stderr);
      expect(stateFile.existsSync(), isFalse);
      expect(File(p.join(project.path, 'web', 'index.html')).existsSync(), isFalse);
      expect(
        File(
          p.join(project.path, 'tool', 'build_resilient_web.sh'),
        ).existsSync(),
        isFalse,
      );
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test(
    'e2e: hard-update package + install refuses dirty managed file',
    () async {
      final project = await _createFlutterProject();
      addTearDown(() {
        if (project.existsSync()) {
          project.deleteSync(recursive: true);
        }
      });

      var result = await _runCli(project, ['install']);
      expect(result.exitCode, 0, reason: result.stderr);

      final index = File(p.join(project.path, 'web', 'index.html'));
      index.writeAsStringSync('${index.readAsStringSync()}\n<!-- dirty -->\n');

      result = await _runCli(project, ['install']);
      expect(result.exitCode, isNot(0));
      expect(result.stderr.toString(), contains('edited since the last install'));

      result = await _runCli(project, ['install', '--force']);
      expect(result.exitCode, 0, reason: result.stderr);
      expect(index.readAsStringSync(), isNot(contains('<!-- dirty -->')));

      _writeBuildOutput(project);
      result = await _runCli(project, [
        'package',
        '--version',
        'hardupdate1',
        '--hard-update',
        '--force',
      ]);
      expect(result.exitCode, 0, reason: result.stderr);

      final manifest =
          jsonDecode(
                File(
                  p.join(project.path, 'build', 'web_hardened', 'latest.json'),
                ).readAsStringSync(),
              )
              as Map;
      expect(manifest['version'], 'hardupdate1');
      expect(manifest['hardUpdate'], isTrue);
      expect(manifest['base'], '/version/hardupdate1/');
    },
  );
}

Future<Directory> _createFlutterProject() async {
  final project = await Directory.systemTemp.createTemp(
    'resilient_bootstrap_e2e_',
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

Future<void> _servePackaged(Directory outRoot, HttpRequest request) async {
  final relative = Uri.decodeComponent(request.uri.path);
  final cleaned = relative.startsWith('/') ? relative.substring(1) : relative;
  final file = File(p.join(outRoot.path, cleaned));

  if (!file.existsSync() || !p.isWithin(outRoot.path, file.path)) {
    request.response.statusCode = HttpStatus.notFound;
    await request.response.close();
    return;
  }

  final bytes = file.readAsBytesSync();
  final isHtml = cleaned == 'index.html' || cleaned.endsWith('/index.html');
  final isLatest = cleaned == 'latest.json' || cleaned.endsWith('/latest.json');
  final isVersionAsset = cleaned.startsWith('version/');

  if (isHtml || isLatest) {
    request.response.headers.set(
      HttpHeaders.cacheControlHeader,
      'no-cache, must-revalidate',
    );
  } else if (isVersionAsset) {
    request.response.headers.set(
      HttpHeaders.cacheControlHeader,
      'public, max-age=31536000, immutable',
    );
  }
  request.response.headers.set(HttpHeaders.acceptRangesHeader, 'bytes');

  final range = request.headers.value(HttpHeaders.rangeHeader);
  if (range != null && range.startsWith('bytes=')) {
    final spec = range.substring('bytes='.length);
    final parts = spec.split('-');
    final start = int.parse(parts[0]);
    final end = parts[1].isEmpty ? bytes.length - 1 : int.parse(parts[1]);
    final slice = bytes.sublist(start, end + 1);
    request.response.statusCode = HttpStatus.partialContent;
    request.response.headers.set(
      HttpHeaders.contentRangeHeader,
      'bytes $start-$end/${bytes.length}',
    );
    request.response.headers.contentLength = slice.length;
    request.response.add(slice);
  } else {
    request.response.statusCode = HttpStatus.ok;
    request.response.headers.contentLength = bytes.length;
    request.response.add(bytes);
  }
  await request.response.close();
}

final class _HttpBody {
  _HttpBody({
    required this.statusCode,
    required this.headers,
    required this.body,
  });

  final int statusCode;
  final HttpHeaders headers;
  final List<int> body;
}

Future<_HttpBody> _get(
  HttpClient client,
  String url, {
  Map<String, String> headers = const {},
}) async {
  final request = await client.getUrl(Uri.parse(url));
  headers.forEach(request.headers.set);
  final response = await request.close();
  final body = await consolidateHttpClientResponseBytes(response);
  return _HttpBody(
    statusCode: response.statusCode,
    headers: response.headers,
    body: body,
  );
}

Future<List<int>> consolidateHttpClientResponseBytes(
  HttpClientResponse response,
) async {
  final builder = BytesBuilder(copy: false);
  await for (final chunk in response) {
    builder.add(chunk);
  }
  return builder.takeBytes();
}
