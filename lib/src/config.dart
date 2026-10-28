import 'dart:io';

import 'package:yaml/yaml.dart';

final class BootstrapConfig {
  const BootstrapConfig({
    required this.title,
    required this.description,
    required this.loaderLabel,
    required this.tokenMessageType,
    required this.versionPath,
    required this.hardUpdate,
    required this.cleanupPage,
    this.basePath = '/',
    this.cleanupEnabled = true,
    this.keepDays = 90,
    this.keepReleases = 3,
    this.assetGraceDays = 90,
    this.collectAssets = true,
  });

  factory BootstrapConfig.defaults() => const BootstrapConfig(
    title: 'Flutter App',
    description: 'Hardened Flutter web app',
    loaderLabel: 'Loading',
    tokenMessageType: 'flutter-bootstrap-token',
    versionPath: '/version',
    hardUpdate: false,
    cleanupPage: 'cleanup_cache.html',
  );

  final String basePath;
  final bool cleanupEnabled;
  final int keepDays;
  final int keepReleases;
  final int assetGraceDays;
  final bool collectAssets;

  String get releaseUrlRoot =>
      '${basePath.replaceAll(RegExp(r"/+$"), "")}/${versionPath.replaceAll(RegExp(r"^/+|/+$"), "")}';

  final String title;
  final String description;
  final String loaderLabel;
  final String tokenMessageType;
  final String versionPath;
  final bool hardUpdate;
  final String cleanupPage;

  BootstrapConfig copyWith({
    String? title,
    String? description,
    String? loaderLabel,
    String? tokenMessageType,
    String? versionPath,
    bool? hardUpdate,
    String? cleanupPage,
    String? basePath,
    bool? cleanupEnabled,
    int? keepDays,
    int? keepReleases,
    int? assetGraceDays,
    bool? collectAssets,
  }) {
    return BootstrapConfig(
      basePath: basePath ?? this.basePath,
      cleanupEnabled: cleanupEnabled ?? this.cleanupEnabled,
      keepDays: keepDays ?? this.keepDays,
      keepReleases: keepReleases ?? this.keepReleases,
      assetGraceDays: assetGraceDays ?? this.assetGraceDays,
      collectAssets: collectAssets ?? this.collectAssets,
      title: title ?? this.title,
      description: description ?? this.description,
      loaderLabel: loaderLabel ?? this.loaderLabel,
      tokenMessageType: tokenMessageType ?? this.tokenMessageType,
      versionPath: versionPath ?? this.versionPath,
      hardUpdate: hardUpdate ?? this.hardUpdate,
      cleanupPage: cleanupPage ?? this.cleanupPage,
    );
  }

  static BootstrapConfig load(Directory projectRoot) {
    final defaults = BootstrapConfig.defaults();
    final file = File(
      '${projectRoot.path}${Platform.pathSeparator}resilient_bootstrap.yaml',
    );
    if (!file.existsSync()) {
      return defaults;
    }

    final document = loadYaml(file.readAsStringSync());
    if (document is! YamlMap) {
      throw FormatException('Expected a YAML map in ${file.path}');
    }

    final app = document['app'];
    final bootstrap = document['bootstrap'];
    final cleanup = document['cleanup'];
    return defaults.copyWith(
      basePath: _readString(bootstrap, 'basePath') ?? defaults.basePath,
      cleanupEnabled: _readBool(cleanup, 'enabled') ?? defaults.cleanupEnabled,
      keepDays: _readInt(cleanup, 'keepDays') ?? defaults.keepDays,
      keepReleases: _readInt(cleanup, 'keepReleases') ?? defaults.keepReleases,
      assetGraceDays:
          _readInt(cleanup, 'assetGraceDays') ?? defaults.assetGraceDays,
      collectAssets:
          _readBool(cleanup, 'collectAssets') ?? defaults.collectAssets,
      title: _readString(app, 'title') ?? defaults.title,
      description: _readString(app, 'description') ?? defaults.description,
      loaderLabel: _readString(app, 'loaderLabel') ?? defaults.loaderLabel,
      tokenMessageType:
          _readString(app, 'tokenMessageType') ?? defaults.tokenMessageType,
      versionPath:
          _readString(bootstrap, 'versionPath') ?? defaults.versionPath,
      hardUpdate: _readBool(bootstrap, 'hardUpdate') ?? defaults.hardUpdate,
      cleanupPage:
          _readString(bootstrap, 'cleanupPage') ?? defaults.cleanupPage,
    );
  }

  String toYaml() {
    return '''
app:
  title: ${_quoteYaml(title)}
  description: ${_quoteYaml(description)}
  loaderLabel: ${_quoteYaml(loaderLabel)}
  tokenMessageType: ${_quoteYaml(tokenMessageType)}

bootstrap:
  basePath: ${_quoteYaml(basePath)}
  versionPath: ${_quoteYaml(versionPath)}
  hardUpdate: $hardUpdate
  cleanupPage: ${_quoteYaml(cleanupPage)}

cleanup:
  enabled: $cleanupEnabled
  keepDays: $keepDays
  keepReleases: $keepReleases
  assetGraceDays: $assetGraceDays
  collectAssets: $collectAssets
''';
  }
}

String? _readString(Object? parent, String key) {
  if (parent is! YamlMap) {
    return null;
  }
  final value = parent[key];
  return value?.toString();
}

bool? _readBool(Object? parent, String key) {
  if (parent is! YamlMap) {
    return null;
  }
  final value = parent[key];
  if (value is bool) {
    return value;
  }
  if (value == null) {
    return null;
  }
  final text = value.toString().toLowerCase();
  if (text == 'true') {
    return true;
  }
  if (text == 'false') {
    return false;
  }
  throw FormatException('Expected boolean for bootstrap.$key');
}

String _quoteYaml(String value) {
  final escaped = value.replaceAll(r'\', r'\\').replaceAll('"', r'\"');
  return '"$escaped"';
}

int? _readInt(Object? parent, String key) {
  if (parent is! YamlMap || parent[key] == null) return null;
  final value = int.tryParse(parent[key].toString());
  if (value == null || value < 0) {
    throw FormatException('Expected nonnegative integer for cleanup.$key');
  }
  return value;
}
