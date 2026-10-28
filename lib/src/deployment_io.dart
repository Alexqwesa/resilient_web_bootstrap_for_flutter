import 'dart:io';

import 'package:path/path.dart' as p;

String webPath(String path) => path.replaceAll(r'\', '/');

/// All maintenance paths are relative physical paths, never URLs.
void validateRelativePath(String path) {
  if (path.isEmpty ||
      path.contains(RegExp(r'[\\:%?#\x00]')) ||
      path.startsWith('/') ||
      path
          .split('/')
          .any((part) => part.isEmpty || part == '.' || part == '..')) {
    throw FormatException('Unsafe deployment path: $path');
  }
}

File safeFile(Directory root, String relative) {
  validateRelativePath(relative);
  var current = p.absolute(root.path);
  var ancestor = current;
  while (true) {
    if (FileSystemEntity.isLinkSync(ancestor)) {
      throw StateError('Symlink in deployment path: $ancestor');
    }
    final parent = p.dirname(ancestor);
    if (parent == ancestor) break;
    ancestor = parent;
  }
  for (final part in relative.split('/')) {
    current = p.join(current, part);
    if (FileSystemEntity.isLinkSync(current)) {
      throw StateError('Symlink in deployment path: $current');
    }
  }
  return File(current);
}

final class DeploymentLock {
  DeploymentLock(Directory root) {
    safeFile(root, '.resilient-deploy.lock');
    root.createSync(recursive: true);
    file = File(p.join(root.path, '.resilient-deploy.lock'));
    try {
      file.createSync(exclusive: true);
    } on FileSystemException {
      throw StateError(
        'Deployment/cleanup already active: ${file.path}. '
        'Remove a stale lock only after checking no operation is running.',
      );
    }
  }
  late final File file;
  void release() => file.deleteSync();
}

void atomicWrite(File target, String text) {
  target.parent.createSync(recursive: true);
  final temporary = File('${target.path}.pending');
  if (FileSystemEntity.isLinkSync(temporary.path)) {
    throw StateError('Symlink at ${temporary.path}');
  }
  temporary.writeAsStringSync(text, flush: true);
  temporary.renameSync(target.path);
}

void copyTree(
  Directory source,
  Directory target, {
  Set<String> exclude = const {},
}) {
  target.createSync(recursive: true);
  for (final entity in source.listSync(recursive: true, followLinks: false)) {
    final relative = webPath(p.relative(entity.path, from: source.path));
    if (exclude.any(
      (path) => relative == path || relative.startsWith('$path/'),
    )) {
      continue;
    }
    if (entity is Link) throw StateError('Symlink in source: ${entity.path}');
    final destination = safeFile(target, relative);
    if (entity is Directory) {
      Directory(destination.path).createSync(recursive: true);
    }
    if (entity is File) {
      destination.parent.createSync(recursive: true);
      entity.copySync(destination.path);
    }
  }
}
