import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

String sha256Bytes(List<int> bytes) => sha256.convert(bytes).toString();

String sha256File(File file) => sha256Bytes(file.readAsBytesSync());

String sha256Text(String text) => sha256Bytes(utf8.encode(text));
