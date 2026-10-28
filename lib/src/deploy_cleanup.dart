import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'deployment_io.dart';

DateTime retentionCutoff(DateTime now, {int? months, int days = 90}) {
  if ((months != null && months < 0) || days < 0) {
    throw ArgumentError('Retention must be nonnegative.');
  }
  now = now.toUtc();
  if (months == null) return now.subtract(Duration(days: days));
  final first = DateTime.utc(now.year, now.month - months);
  final last = DateTime.utc(first.year, first.month + 1, 0).day;
  return DateTime.utc(
    first.year,
    first.month,
    now.day > last ? last : now.day,
    now.hour,
    now.minute,
    now.second,
    now.millisecond,
    now.microsecond,
  );
}

DateTime? releaseDate(Map manifest, String name) {
  final stamp = manifest['createdAt'];
  if (stamp != null) {
    final value = stamp is String ? DateTime.tryParse(stamp) : null;
    return value != null && value.isUtc ? value : null;
  }
  if (!RegExp(r'^\d{12}(\d{2})?$').hasMatch(name)) return null;
  final value = DateTime.tryParse(
    '${name.substring(0, 4)}-${name.substring(4, 6)}-'
    '${name.substring(6, 8)}T${name.substring(8, 10)}:${name.substring(10, 12)}:'
    '${name.length == 14 ? name.substring(12, 14) : '00'}Z',
  );
  if (value == null ||
      value.month.toString().padLeft(2, '0') != name.substring(4, 6) ||
      value.day.toString().padLeft(2, '0') != name.substring(6, 8)) {
    return null;
  }
  return value;
}

final class CleanupEntry {
  CleanupEntry(this.path, this.action, this.bytes, this.reason);
  final String path;
  final String action;
  final int bytes;
  final String reason;
  @override
  String toString() => '$action $path ($bytes bytes): $reason';
}

/// Standalone server maintenance; no dependency on Flutter or build output.
List<CleanupEntry> cleanupDeployment({
  required Directory root,
  String versionDirectory = 'version',
  DateTime? now,
  int keepDays = 90,
  int? keepMonths,
  int keepReleases = 3,
  int assetGraceDays = 90,
  bool collectAssets = true,
  Set<String> protectedVersions = const {},
  bool apply = false,
}) {
  if (keepReleases < 0 || assetGraceDays < 0) {
    throw ArgumentError('Retention must be nonnegative');
  }
  final cutoff = retentionCutoff(
    now ?? DateTime.now(),
    months: keepMonths,
    days: keepDays,
  );
  final assetCutoff = (now ?? DateTime.now()).toUtc().subtract(
    Duration(days: assetGraceDays),
  );
  final lock = DeploymentLock(root);
  try {
    final current =
        jsonDecode(safeFile(root, 'latest.json').readAsStringSync()) as Map;
    if (current['version'] is! String) {
      throw const FormatException('Missing current release');
    }
    final protected = {...protectedVersions, current['version'] as String};
    final index = safeFile(root, 'index.html');
    if (index.existsSync()) {
      final match = RegExp(
        "const defaultBuildVersion = '([^']+)';",
      ).firstMatch(index.readAsStringSync());
      if (match != null) protected.add(match[1]!);
    }
    final versions = Directory(
      safeFile(root, '$versionDirectory/placeholder').parent.path,
    );
    if (!versions.existsSync()) throw StateError('Missing version directory');
    final entries = <CleanupEntry>[];
    final releases =
        <({Directory dir, String name, Map? manifest, DateTime? date})>[];
    var dependenciesKnown = true;
    for (final entity in versions.listSync(followLinks: false)) {
      final name = p.basename(entity.path);
      if (name.startsWith('.')) {
        // An abandoned staging directory requires operator inspection.
        entries.add(
          CleanupEntry(
            '$versionDirectory/$name',
            'skip',
            0,
            'staged deployment',
          ),
        );
        dependenciesKnown = false;
        continue;
      }
      if (entity is! Directory) {
        entries.add(
          CleanupEntry(
            '$versionDirectory/$name',
            'skip',
            0,
            'unknown entry or symlink',
          ),
        );
        dependenciesKnown = false;
        continue;
      }
      Map? manifest;
      DateTime? date;
      try {
        manifest =
            jsonDecode(safeFile(entity, 'latest.json').readAsStringSync())
                as Map;
        if (manifest['version'] != name) {
          throw const FormatException('Version mismatch');
        }
        date = releaseDate(manifest, name);
      } on Object {
        manifest = null;
      }
      releases.add((dir: entity, name: name, manifest: manifest, date: date));
    }
    final dated = releases.where((r) => r.date != null).toList()
      ..sort((a, b) => b.date!.compareTo(a.date!));
    protected.addAll(dated.take(keepReleases).map((r) => r.name));
    for (final release in releases) {
      if (release.date == null || !release.date!.isBefore(cutoff)) {
        protected.add(release.name);
      }
    }
    // Old whole-bundle manifests may point into another release's assets.
    var changed = true;
    while (changed) {
      changed = false;
      for (final release in releases.where((r) => protected.contains(r.name))) {
        final base = release.manifest?['assetBase'];
        if (base is! String) continue;
        for (final other in releases) {
          if (base == other.manifest?['base'] && protected.add(other.name)) {
            changed = true;
          }
        }
      }
    }
    if (!releases.any((r) => r.name == current['version'])) {
      throw StateError(
        'Current release directory is missing; refusing cleanup',
      );
    }
    final referenced = <String>{};
    for (final release in releases.where((r) => protected.contains(r.name))) {
      try {
        final refs = jsonDecode(
          safeFile(release.dir, 'asset_refs.json').readAsStringSync(),
        );
        if (refs is! Map || refs['version'] != 1 || refs['assets'] is! List) {
          throw const FormatException('Unknown dependency metadata');
        }
        for (final path in refs['assets'] as List) {
          if (path is! String || !path.startsWith('assets/')) {
            throw const FormatException('Unsafe asset reference');
          }
          if (!safeFile(root, path).existsSync()) {
            throw StateError('Missing asset $path');
          }
          referenced.add(path);
        }
      } on Object {
        dependenciesKnown = false;
      }
    }
    // Plan everything before performing any destructive operation.
    final deleteFiles = <File>[];
    final deleteReleases = <Directory>[];
    for (final release in releases) {
      var bytes = 0;
      var safe = true;
      for (final entity in release.dir.listSync(
        recursive: true,
        followLinks: false,
      )) {
        if (entity is Link) safe = false;
        if (entity is File) bytes += entity.lengthSync();
      }
      final retained = protected.contains(release.name);
      final action = retained
          ? 'retain'
          : safe
          ? 'delete'
          : 'skip';
      entries.add(
        CleanupEntry(
          '$versionDirectory/${release.name}',
          action,
          bytes,
          retained
              ? 'current, protected, recent, or unknown age'
              : safe
              ? 'expired release'
              : 'contains symlink',
        ),
      );
      if (!retained && safe) deleteReleases.add(release.dir);
      if (!safe) dependenciesKnown = false;
    }
    final shared = Directory(safeFile(root, 'assets/placeholder').parent.path);
    if (shared.existsSync()) {
      for (final entity in shared.listSync(
        recursive: true,
        followLinks: false,
      )) {
        if (entity is Directory) continue;
        final path = webPath(p.relative(entity.path, from: root.path));
        if (entity is! File) {
          entries.add(
            CleanupEntry(path, 'skip', 0, 'symlink or unknown entry'),
          );
          continue;
        }
        final used = referenced.contains(path);
        final eligible =
            collectAssets &&
            dependenciesKnown &&
            !used &&
            entity.lastModifiedSync().toUtc().isBefore(assetCutoff);
        entries.add(
          CleanupEntry(
            path,
            eligible
                ? 'delete'
                : used
                ? 'retain'
                : 'skip',
            entity.lengthSync(),
            used
                ? 'referenced'
                : !dependenciesKnown
                ? 'unknown release dependencies'
                : !collectAssets
                ? 'asset GC disabled'
                : eligible
                ? 'unreferenced, beyond grace period'
                : 'within grace period',
          ),
        );
        if (eligible) deleteFiles.add(entity);
      }
    }
    if (apply) {
      for (final release in deleteReleases) {
        safeFile(root, webPath(p.relative(release.path, from: root.path)));
        release.deleteSync(recursive: true);
      }
      for (final file in deleteFiles) {
        safeFile(
          root,
          webPath(p.relative(file.path, from: root.path)),
        ).deleteSync();
      }
    }
    return entries;
  } finally {
    lock.release();
  }
}
