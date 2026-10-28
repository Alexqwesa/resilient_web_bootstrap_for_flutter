import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'assets.dart';
import 'deployment_io.dart';
import 'hashing.dart';

void validateRelease(Directory root, Map manifest, String releasePath) {
  final release = Directory(
    safeFile(root, '${releasePath}latest.json').parent.path,
  );
  final files = manifest['files'];
  if (files is! List || files.isEmpty) {
    throw const FormatException('Missing release files');
  }
  for (final entry in files) {
    if (entry is! Map || entry['path'] is! String) {
      throw const FormatException('Invalid release file');
    }
    for (final prefix in ['', 'gz']) {
      final path = entry[prefix.isEmpty ? 'path' : 'gzPath'];
      if (path == null && prefix.isNotEmpty) continue;
      final file = safeFile(release, path as String);
      if (!file.existsSync() ||
          file.lengthSync() != entry[prefix.isEmpty ? 'size' : 'gzSize'] ||
          sha256File(file) != entry[prefix.isEmpty ? 'sha256' : 'gzSha256']) {
        throw StateError('Invalid release dependency: ${file.path}');
      }
    }
  }
  final refs = safeFile(release, 'asset_refs.json');
  if (refs.existsSync()) {
    final data = jsonDecode(refs.readAsStringSync());
    if (data is! Map || data['version'] != 1 || data['assets'] is! List) {
      throw const FormatException('Invalid asset references');
    }
    for (final path in data['assets'] as List) {
      if (path is! String ||
          !path.startsWith('assets/') ||
          !safeFile(root, path).existsSync()) {
        throw StateError('Missing shared asset: $path');
      }
    }
  }
}

/// Merge immutable files first; publish mutable root pointers last.
void deployPackage(Directory source, Directory destination) {
  final a = p.normalize(p.absolute(source.path));
  final b = p.normalize(p.absolute(destination.path));
  if (p.equals(a, b) || p.isWithin(a, b) || p.isWithin(b, a)) {
    throw ArgumentError('Source and destination must be separate directories');
  }
  final sourceLock = DeploymentLock(source);
  DeploymentLock? destinationLock;
  Directory? staging;
  try {
    final manifestText = safeFile(source, 'latest.json').readAsStringSync();
    final manifest = jsonDecode(manifestText) as Map;
    final releasePath =
        manifest['releasePath'] as String? ??
        (manifest['base'] as String).replaceFirst(RegExp(r'^/+'), '');
    validateRelativePath('${releasePath}latest.json');
    validateRelease(source, manifest, releasePath);
    destinationLock = DeploymentLock(destination);
    staging = destination.createTempSync('.staging-');
    final sourceRelease = Directory(
      safeFile(source, '${releasePath}latest.json').parent.path,
    );
    final stagedRelease = Directory(p.join(staging.path, 'release'));
    copyTree(sourceRelease, stagedRelease);
    final refs = safeFile(sourceRelease, 'asset_refs.json');
    if (refs.existsSync()) {
      final paths =
          ((jsonDecode(refs.readAsStringSync()) as Map)['assets'] as List)
              .cast<String>();
      for (final path in paths) {
        final target = safeFile(staging, path);
        target.parent.createSync(recursive: true);
        safeFile(source, path).copySync(target.path);
      }
      publishSharedAssets(staging, destination, paths);
    }
    final releaseTarget = Directory(
      safeFile(destination, '${releasePath}latest.json').parent.path,
    );
    if (releaseTarget.existsSync()) {
      final sourceFiles = stagedRelease
          .listSync(recursive: true)
          .whereType<File>()
          .toList();
      final existingFiles = releaseTarget
          .listSync(recursive: true, followLinks: false)
          .whereType<File>()
          .toList();
      if (sourceFiles.length != existingFiles.length) {
        throw StateError(
          'Immutable release already exists with different files',
        );
      }
      for (final file in sourceFiles) {
        final other = safeFile(
          releaseTarget,
          webPath(p.relative(file.path, from: stagedRelease.path)),
        );
        if (!other.existsSync() || sha256File(file) != sha256File(other)) {
          throw StateError('Immutable release collision: ${other.path}');
        }
      }
    } else {
      releaseTarget.parent.createSync(recursive: true);
      stagedRelease.renameSync(releaseTarget.path);
    }
    validateRelease(destination, manifest, releasePath);
    // Never copy maintenance scripts or remove destination files absent locally.
    final index = safeFile(source, 'index.html').readAsStringSync();
    for (final name in [
      'robots.txt',
      'sitemap.xml',
      'sitemap_index.xml',
      'status.json',
    ]) {
      final file = safeFile(source, name);
      if (file.existsSync()) {
        atomicWrite(safeFile(destination, name), file.readAsStringSync());
      }
    }
    atomicWrite(safeFile(destination, 'latest.json'), manifestText);
    atomicWrite(safeFile(destination, 'index.html'), index);
  } finally {
    if (staging != null && staging.existsSync()) {
      staging.deleteSync(recursive: true);
    }
    destinationLock?.release();
    sourceLock.release();
  }
}
