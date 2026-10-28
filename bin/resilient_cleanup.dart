import 'package:resilient_web_bootstrap_for_flutter/src/cli.dart';

/// Compile this executable on the build machine; copy it outside the web root.
Future<void> main(List<String> arguments) =>
    ResilientBootstrapCli().run(['cleanup', ...arguments]);
