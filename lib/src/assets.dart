import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'deployment_io.dart';
import 'hashing.dart';

/// Flutter owns filenames and runtime mapping. This inventory is server-only.
List<String>? readHashedAssets(Directory build) {
  final manifest = safeFile(build, 'precache_manifest.json');
  if (!manifest.existsSync()) return null;
  final data = jsonDecode(manifest.readAsStringSync());
  if (data is! Map || data['version'] != 1 || data['entries'] is! List) {
    throw const FormatException('Unsupported Flutter precache_manifest.json');
  }
  // A build without --web-content-hash may still emit an inventory; keep it legacy.
  if (!(data['entries'] as List).any(
    (entry) =>
        entry is Map &&
        entry['urlHashed'] == true &&
        '${entry['url']}'.startsWith('assets/'),
  )) {
    return null;
  }
  final assets = <String>{};
  final seen = <String>{};
  for (final entry in data['entries'] as List) {
    if (entry is! Map || entry['url'] is! String) {
      throw const FormatException('Invalid Flutter precache entry');
    }
    final path = entry['url'] as String;
    final file = safeFile(build, path);
    if (!seen.add(path) ||
        !file.existsSync() ||
        file.lengthSync() != entry['size'] ||
        sha256File(file).substring(0, 8) != entry['hash']) {
      throw StateError('Flutter inventory does not match build output: $path');
    }
    if (!path.startsWith('assets/')) continue;
    final hash = entry['hash'];
    final name = p.posix.basename(path);
    if (entry['urlHashed'] != true ||
        !(name.contains('.$hash.') || name.endsWith('.$hash'))) {
      throw StateError('Unhashed asset in content-hashed build: $path');
    }
    assets.add(path);
  }
  final directory = Directory(p.join(build.path, 'assets'));
  if (directory.existsSync()) {
    for (final entity in directory.listSync(
      recursive: true,
      followLinks: false,
    )) {
      if (entity is Link) {
        throw StateError('Symlink in build assets: ${entity.path}');
      }
      if (entity is File) {
        final path = webPath(p.relative(entity.path, from: build.path));
        if (!assets.contains(path)) {
          throw StateError('Asset absent from Flutter inventory: $path');
        }
      }
    }
  }
  return assets.toList()..sort();
}

void publishSharedAssets(Directory staged, Directory root, List<String> paths) {
  // Validate all collisions first. Full SHA-256 protects against short-hash collisions.
  for (final path in paths) {
    final source = safeFile(staged, path);
    final target = safeFile(root, path);
    if (target.existsSync() && sha256File(source) != sha256File(target)) {
      throw StateError('Shared immutable asset has different bytes: $path');
    }
  }
  for (final path in paths) {
    final source = safeFile(staged, path);
    final target = safeFile(root, path);
    if (!target.existsSync()) {
      target.parent.createSync(recursive: true);
      final temporary = safeFile(root, '$path.pending');
      source.copySync(temporary.path);
      temporary.renameSync(target.path);
    }
  }
}
