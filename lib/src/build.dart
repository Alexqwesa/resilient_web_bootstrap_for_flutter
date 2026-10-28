import 'dart:convert';
import 'dart:io';

/// Preserve argument boundaries, including paths and dart-defines with spaces.
Future<void> buildWeb(Directory project, List<String> arguments) async {
  final flutterArgs = <String>[];
  final packageArgs = <String>['--force'];
  var mode = '--release';
  bool? hashing;
  for (var i = 0; i < arguments.length; i++) {
    final arg = arguments[i];
    if (['--debug', '--profile', '--release'].contains(arg)) {
      mode = arg;
    } else if (arg == '--web-content-hash' || arg == '--no-web-content-hash') {
      hashing = arg == '--web-content-hash';
    } else if (['--hard-update', '--cleanup', '--no-cleanup'].contains(arg)) {
      packageArgs.add(arg);
    } else if (['--version', '--out', '--build-dir'].contains(arg)) {
      if (++i >= arguments.length) throw ArgumentError('$arg requires a value');
      packageArgs.addAll([arg, arguments[i]]);
    } else if (['--version=', '--out=', '--build-dir='].any(arg.startsWith)) {
      packageArgs.add(arg);
    } else {
      flutterArgs.add(arg);
    }
  }
  final useHash = hashing ?? mode == '--release';
  if (useHash) {
    final result = await Process.run(
      'flutter',
      ['--version', '--machine'],
      workingDirectory: project.path,
      runInShell: Platform.isWindows,
    );
    if (result.exitCode != 0) {
      throw StateError('Cannot query Flutter SDK: ${result.stderr}');
    }
    final data = jsonDecode(result.stdout.toString()) as Map;
    final version = data['frameworkVersion'].toString();
    final match = RegExp(r'^(\d+)\.(\d+)\.').firstMatch(version);
    if (match == null ||
        int.parse(match[1]!) < 3 ||
        (int.parse(match[1]!) == 3 && int.parse(match[2]!) < 50)) {
      throw StateError(
        'Native content hashing requires Flutter 3.50+. Found $version. '
        'Upgrade Flutter or pass --no-web-content-hash for a legacy build.',
      );
    }
    if (flutterArgs.contains('--enable-wasm-deferred-loading')) {
      throw ArgumentError(
        'Native content hashing cannot be combined with deferred loading. '
        'Remove --enable-wasm-deferred-loading or use --no-web-content-hash.',
      );
    }
  }
  final child = await Process.start(
    'flutter',
    ['build', 'web', mode, if (useHash) '--web-content-hash', ...flutterArgs],
    workingDirectory: project.path,
    runInShell: Platform.isWindows,
    mode: ProcessStartMode.inheritStdio,
  );
  final code = await child.exitCode;
  if (code != 0) {
    throw StateError(
      'Flutter build failed ($code); previous deployment preserved.',
    );
  }
  // Resolve the package CLI without depending on how its executable was launched.
  final package = await Process.start(
    Platform.resolvedExecutable,
    [
      'run',
      'resilient_web_bootstrap_for_flutter:resilient_bootstrap',
      '--project',
      '.',
      'package',
      ...packageArgs,
    ],
    workingDirectory: project.path,
    mode: ProcessStartMode.inheritStdio,
  );
  if (await package.exitCode != 0) throw StateError('Packaging failed.');
}
