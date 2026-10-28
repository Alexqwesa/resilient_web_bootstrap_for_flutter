import 'dart:ui' as ui;
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:web/web.dart' as web;

/// Set at build time: `--dart-define=E2E_VERSION=before_apply`
const e2eVersion = String.fromEnvironment(
  'E2E_VERSION',
  defaultValue: 'unknown',
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final json = await rootBundle.loadString('assets/probe.json');
  if (!json.contains('"probe":true'))
    throw StateError('rootBundle content mismatch');
  await rootBundle.load('assets/probe.png');
  final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
  if (!manifest.listAssets().contains('assets/probe.png'))
    throw StateError('Asset manifest mismatch');
  await ui.FragmentProgram.fromAsset('shaders/probe.frag');
  web.document.documentElement?.setAttribute('data-e2e-assets', 'ready');
  // CanvasKit draws text on a canvas, so e2e asserts this DOM/JS marker instead.
  web.document.documentElement?.setAttribute('data-e2e-flutter', e2eVersion);
  globalContext.setProperty('__E2E_FLUTTER_VERSION__'.toJS, e2eVersion.toJS);

  runApp(const E2eFlutterApp());
}

final class E2eFlutterApp extends StatelessWidget {
  const E2eFlutterApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        backgroundColor: const Color(0xFF0E1514),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Image.asset('assets/probe.png', width: 32, height: 32),
              const Icon(Icons.check),
              Text(
                'E2E Flutter $e2eVersion',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 28,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
