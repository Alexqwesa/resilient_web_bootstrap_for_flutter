import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'config.dart';

const runtimeTemplateFiles = <String>[
  'app_update.js',
  'boot_download_helpers.js',
  'fflate.min.js',
  'sha256_fallback.js',
  'cleanup_cache.html',
];

const installedTemplateFiles = <String>[
  'index.html',
  'flutter_bootstrap.js',
  ...runtimeTemplateFiles,
];

Future<String> readTemplate(String fileName) async {
  final uri = await Isolate.resolvePackageUri(
    Uri.parse(
      'package:resilient_web_bootstrap_for_flutter/templates/web/$fileName',
    ),
  );
  if (uri == null) {
    throw StateError('Cannot resolve template: $fileName');
  }
  return utf8.decode(await File.fromUri(uri).readAsBytes());
}

Future<List<int>> readTemplateBytes(String fileName) async {
  final uri = await Isolate.resolvePackageUri(
    Uri.parse(
      'package:resilient_web_bootstrap_for_flutter/templates/web/$fileName',
    ),
  );
  if (uri == null) {
    throw StateError('Cannot resolve template: $fileName');
  }
  return File.fromUri(uri).readAsBytes();
}

String renderTemplate(
  String text,
  BootstrapConfig config, {
  String? buildVersion,
}) {
  var rendered = text
      .replaceAll('__RESILIENT_APP_TITLE__', _jsHtmlSafe(config.title))
      .replaceAll(
        '__RESILIENT_APP_DESCRIPTION__',
        _jsHtmlSafe(config.description),
      )
      .replaceAll(
        '__RESILIENT_LOADER_LABEL__',
        _jsHtmlStringSafe(config.loaderLabel),
      )
      .replaceAll(
        '__RESILIENT_TOKEN_MESSAGE_TYPE__',
        _jsStringSafe(config.tokenMessageType),
      );

  if (buildVersion != null) {
    rendered = rendered.replaceAll(
      "const defaultBuildVersion = '__DEFAULT_BUILD_VERSION__';",
      "const defaultBuildVersion = '${_jsStringSafe(buildVersion)}';",
    );
  }

  return rendered;
}

String _jsHtmlSafe(String value) {
  return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
}

String _jsStringSafe(String value) {
  return value.replaceAll(r'\', r'\\').replaceAll("'", r"\'");
}

String _jsHtmlStringSafe(String value) => _jsStringSafe(_jsHtmlSafe(value));
