(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.BootDownloadHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  let fflateLoadPromise = null;
  let sha256FallbackLoadPromise = null;
  const completedBootDownloads = new Map();
  const inflightBootDownloads = new Map();
  const bootPersistentCacheName = 'boot-downloads-v1';
  const pinnedBootPersistentCacheName = `${bootPersistentCacheName}-pinned`;
  const pinnedBootPersistentCacheMarkerKey = '/__resilient_boot_pinned_build__';

  function bootSleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function isTransientBootFetchError(error) {
    return (
      (error && error.code === 'READ_IDLE_TIMEOUT') ||
      (error && error.code === 'RANGE_IGNORED') ||
      (error && error.code === 'RANGE_MISMATCH') ||
      (error && error.name === 'AbortError') ||
      (error && error.code === 'ERR_CANCELED') ||
      error instanceof TypeError
    );
  }

  function waitForOnlineOrTimeout(timeoutMs, abortSignal) {
    if (abortSignal && abortSignal.aborted) {
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      return Promise.reject(abortErr);
    }

    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      if (!abortSignal) {
        return bootSleep(timeoutMs);
      }

      return new Promise(function (resolve, reject) {
        let done = false;
        const timer = setTimeout(finish, timeoutMs);

        function onAbort() {
          finish(true);
        }

        function finish(isAbort) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', onAbort);

          if (isAbort) {
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          } else {
            resolve();
          }
        }

        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    }

    return new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(finish, timeoutMs);

      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (typeof window !== 'undefined') {
          window.removeEventListener('online', finish);
        }
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort);
        }
        resolve();
      }

      function onAbort() {
        finish();
      }

      if (typeof window !== 'undefined') {
        window.addEventListener('online', finish, { once: true });
      }
      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function parseTotalFromContentRange(header) {
    if (!header) return null;
    const tail = String(header).trim().split('/').pop();
    if (!tail || tail === '*') return null;
    const n = parseInt(tail, 10);
    return Number.isFinite(n) ? n : null;
  }

  function parseRangeFromContentRange(header) {
    if (!header) return null;
    const match = String(header).trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return null;

    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const total = match[3] === '*' ? null : parseInt(match[3], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return null;
    }

    return {
      start: start,
      end: end,
      total: Number.isFinite(total) ? total : null,
      length: end - start + 1,
    };
  }

  function concatByteChunks(chunkList) {
    let total = 0;
    for (let i = 0; i < chunkList.length; i += 1) {
      total += chunkList[i].byteLength;
    }
    const merged = new Uint8Array(total);
    let pos = 0;
    for (let i = 0; i < chunkList.length; i += 1) {
      merged.set(chunkList[i], pos);
      pos += chunkList[i].byteLength;
    }
    return merged;
  }

  function loadFflateMin() {
    if (typeof window === 'undefined') {
      return Promise.reject(new Error('fflate fallback is not available'));
    }

    if (window.fflate && typeof window.fflate.gunzipSync === 'function') {
      return Promise.resolve(window.fflate);
    }

    if (!fflateLoadPromise) {
      const scriptSrc = inferBootHelpersScriptSrc();
      const fflateUrl = scriptSrc ? new URL('fflate.min.js', scriptSrc).href : '/fflate.min.js';

      fflateLoadPromise = new Promise(function (resolve, reject) {
        const script = document.createElement('script');
        script.src = fflateUrl;
        script.async = true;
        script.onload = function () {
          if (window.fflate && typeof window.fflate.gunzipSync === 'function') {
            resolve(window.fflate);
          } else {
            reject(new Error('fflate.min.js did not load correctly'));
          }
        };
        script.onerror = function () {
          reject(new Error(`Cannot load ${fflateUrl}`));
        };
        (document.head || document.documentElement).appendChild(script);
      });
    }

    return fflateLoadPromise;
  }

  async function gunzipArrayBuffer(buffer) {
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Blob([buffer])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).arrayBuffer();
    }

    const fflate = await loadFflateMin();
    if (!fflate || typeof fflate.gunzipSync !== 'function') {
      throw new Error('This browser does not support gzip decoding');
    }

    const decompressed = fflate.gunzipSync(new Uint8Array(buffer));
    return decompressed.buffer.slice(
      decompressed.byteOffset,
      decompressed.byteOffset + decompressed.byteLength,
    );
  }

  function headersToPlainObject(headersInit) {
    const out = {};
    if (!headersInit) return out;

    if (typeof Headers !== 'undefined' && headersInit instanceof Headers) {
      for (const [key, value] of headersInit.entries()) {
        out[key] = value;
      }
      return out;
    }

    if (Array.isArray(headersInit)) {
      for (const [key, value] of headersInit) {
        out[String(key)] = String(value);
      }
      return out;
    }

    if (typeof headersInit === 'object') {
      for (const key of Object.keys(headersInit)) {
        const value = headersInit[key];
        if (value != null) {
          out[key] = String(value);
        }
      }
    }

    return out;
  }

  function getHeader(headers, name) {
    if (!headers) return null;
    const lower = String(name).toLowerCase();
    if (typeof headers.get === 'function') {
      const value = headers.get(name) || headers.get(lower);
      return value == null ? null : String(value);
    }

    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        const value = headers[key];
        return value == null ? null : String(value);
      }
    }

    return null;
  }

  function normalizeBootUrl(url) {
    try {
      const parsed = new URL(url, typeof window !== 'undefined' ? window.location.href : 'https://example.test/');
      parsed.searchParams.delete('_bootRetry');
      return parsed.toString();
    } catch (_) {
      return String(url).replace(/([?&])_bootRetry=\d+(?:-\d+)?&?/, '$1').replace(/[?&]$/, '');
    }
  }

  function buildAttemptUrl(url, attempt, resumeOffset) {
    if (attempt <= 0 && (!Number.isFinite(resumeOffset) || resumeOffset <= 0)) {
      return url;
    }

    try {
      const parsed = new URL(url, typeof window !== 'undefined' ? window.location.href : 'https://example.test/');
      parsed.searchParams.set('_bootRetry', `${attempt}-${resumeOffset || 0}-${Date.now()}`);
      return parsed.toString();
    } catch (_) {
      const joiner = url.includes('?') ? '&' : '?';
      return `${url}${joiner}_bootRetry=${attempt}-${resumeOffset || 0}-${Date.now()}`;
    }
  }

  function bytesFromAxiosData(data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new Error('Axios response did not return binary data');
  }

  function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.byteLength; i += 1) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function inferBootHelpersScriptSrc() {
    if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
      return document.currentScript.src;
    }

    if (typeof document !== 'undefined') {
      const scripts = document.getElementsByTagName('script');
      for (let i = scripts.length - 1; i >= 0; i -= 1) {
        const src = scripts[i] && scripts[i].src;
        if (src && /\/boot_download_helpers\.js(?:\?|$)/.test(src)) {
          return src;
        }
      }
    }

    return '';
  }

  function canUseSubtleDigest() {
    if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') {
      return false;
    }

    if (typeof globalThis.isSecureContext === 'boolean') {
      return globalThis.isSecureContext;
    }

    return true;
  }

  function loadSha256Fallback() {
    if (typeof window === 'undefined') {
      return Promise.reject(new Error('SHA-256 fallback is not available'));
    }

    if (window.Sha256Fallback && typeof window.Sha256Fallback.sha256Hex === 'function') {
      return Promise.resolve(window.Sha256Fallback);
    }

    if (!sha256FallbackLoadPromise) {
      const scriptSrc = inferBootHelpersScriptSrc();
      const fallbackUrl = scriptSrc
        ? new URL('sha256_fallback.js', scriptSrc).href
        : '/sha256_fallback.js';

      sha256FallbackLoadPromise = new Promise(function (resolve, reject) {
        const script = document.createElement('script');
        script.src = fallbackUrl;
        script.async = true;
        script.onload = function () {
          if (window.Sha256Fallback && typeof window.Sha256Fallback.sha256Hex === 'function') {
            resolve(window.Sha256Fallback);
          } else {
            reject(new Error('sha256_fallback.js did not load correctly'));
          }
        };
        script.onerror = function () {
          reject(new Error(`Cannot load ${fallbackUrl}`));
        };
        (document.head || document.documentElement).appendChild(script);
      });
    }

    return sha256FallbackLoadPromise;
  }

  async function sha256Hex(bytes) {
    if (!bytes) {
      return null;
    }

    const view =
      bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (canUseSubtleDigest()) {
      try {
        const digest = await crypto.subtle.digest('SHA-256', view);
        return bytesToHex(new Uint8Array(digest));
      } catch (error) {
        console.warn(
          '[boot_download_helpers] crypto.subtle SHA-256 failed; using sha256_fallback.js:',
          error,
        );
      }
    }

    if (typeof require === 'function') {
      const nodeCrypto = require('node:crypto');
      return nodeCrypto
        .createHash('sha256')
        .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
        .digest('hex');
    }

    const fallback = await loadSha256Fallback();
    return fallback.sha256Hex(view);
  }

  function normalizeSha256(value) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[a-f0-9]{64}$/.test(text) ? text : null;
  }

  async function readStreamChunkWithAbort(reader, abortSignal) {
    if (!abortSignal) {
      return await reader.read();
    }

    if (abortSignal.aborted) {
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    return await new Promise(function (resolve, reject) {
      let settled = false;

      function cleanup() {
        if (!settled) {
          settled = true;
          abortSignal.removeEventListener('abort', onAbort);
        }
      }

      function finishAbort() {
        if (settled) return;
        cleanup();
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        reject(abortErr);
      }

      function onAbort() {
        if (settled) {
          return;
        }

        if (reader && typeof reader.cancel === 'function') {
          Promise.resolve()
            .then(function () {
              return reader.cancel('aborted');
            })
            .catch(function () {
              return null;
            })
            .then(finishAbort);
          return;
        }

        finishAbort();
      }

      abortSignal.addEventListener('abort', onAbort, { once: true });
      reader.read().then(
        function (result) {
          if (settled) {
            return;
          }
          cleanup();
          resolve(result);
        },
        function (error) {
          if (settled) {
            return;
          }
          cleanup();
          reject(error);
        },
      );
    });
  }

  function extractBootCacheVersion(url) {
    try {
      const parsed = new URL(url, typeof window !== 'undefined' ? window.location.href : 'https://example.test/');
      const match = parsed.pathname.match(/\/version\/([^/]+)\//);
      return match && match[1] ? String(match[1]) : '';
    } catch (_) {
      const match = String(url).match(/\/version\/([^/]+)\//);
      return match && match[1] ? String(match[1]) : '';
    }
  }

  function sanitizeBootCacheVersion(version) {
    return String(version).replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  function getPinnedBootBuild() {
    const root = typeof globalThis !== 'undefined'
      ? globalThis
      : (typeof window !== 'undefined' ? window : null);
    const build = root && root.__resilientPinnedBuild;
    return build ? sanitizeBootCacheVersion(build) : '';
  }

  function getBootPersistentCacheName(url) {
    if (getPinnedBootBuild()) {
      return pinnedBootPersistentCacheName;
    }

    const version = extractBootCacheVersion(url);
    return version
      ? `${bootPersistentCacheName}-${sanitizeBootCacheVersion(version)}`
      : bootPersistentCacheName;
  }

  function getPinnedBootPersistentCacheMarkerUrl() {
    try {
      const origin = typeof window !== 'undefined' && window.location && window.location.origin
        ? window.location.origin
        : 'https://example.test';
      return new URL(pinnedBootPersistentCacheMarkerKey, origin).toString();
    } catch (_) {
      return pinnedBootPersistentCacheMarkerKey;
    }
  }

  function getBootPartialCacheKey(cacheKey) {
    try {
      const parsed = new URL(cacheKey, typeof window !== 'undefined' ? window.location.href : 'https://example.test/');
      parsed.searchParams.set('_bootPartial', '1');
      return parsed.toString();
    } catch (_) {
      const joiner = String(cacheKey).includes('?') ? '&' : '?';
      return `${cacheKey}${joiner}_bootPartial=1`;
    }
  }

  let lastBootPersistentCacheName = null;
  let lastBootPersistentPinnedBuild = null;
  let bootPersistentCacheCleanupPromise = null;

  async function ensurePinnedBootPersistentCacheNamespace() {
    const pinnedBuild = getPinnedBootBuild();
    if (!pinnedBuild || !supportsPersistentBootCache()) {
      return;
    }

    const markerUrl = getPinnedBootPersistentCacheMarkerUrl();
    let cache = await caches.open(pinnedBootPersistentCacheName);
    const marker = await cache.match(markerUrl);
    let previousBuild = '';
    if (marker) {
      try {
        previousBuild = await marker.text();
      } catch (_) {
        previousBuild = '';
      }
    }

    if (previousBuild && previousBuild !== pinnedBuild) {
      await caches.delete(pinnedBootPersistentCacheName);
      cache = await caches.open(pinnedBootPersistentCacheName);
    }

    if (previousBuild !== pinnedBuild) {
      await cache.put(
        markerUrl,
        new Response(pinnedBuild, {
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    }
  }

  async function ensureBootPersistentCacheNamespace(cacheName) {
    if (!supportsPersistentBootCache()) {
      return;
    }

    const pinnedBuild = cacheName === pinnedBootPersistentCacheName
      ? getPinnedBootBuild()
      : null;
    if (
      lastBootPersistentCacheName === cacheName &&
      lastBootPersistentPinnedBuild === pinnedBuild &&
      bootPersistentCacheCleanupPromise
    ) {
      return bootPersistentCacheCleanupPromise;
    }

    lastBootPersistentCacheName = cacheName;
    lastBootPersistentPinnedBuild = pinnedBuild;
    bootPersistentCacheCleanupPromise = cacheName === pinnedBootPersistentCacheName
      ? ensurePinnedBootPersistentCacheNamespace()
      : Promise.resolve();

    return bootPersistentCacheCleanupPromise;
  }

  function supportsPersistentBootCache() {
    return typeof caches !== 'undefined' && caches && typeof caches.open === 'function';
  }

  async function cleanupStaleBootPersistentCacheNamespaces(cacheKey) {
    if (!supportsPersistentBootCache()) {
      return;
    }

    const cacheName = getBootPersistentCacheName(cacheKey);
    const keys = await caches.keys();
    const prefix = `${bootPersistentCacheName}-`;
    const staleKeys = keys.filter(function (key) {
      return (
        key !== pinnedBootPersistentCacheName &&
        (key === bootPersistentCacheName || key.startsWith(prefix)) &&
        key !== cacheName
      );
    });

    await Promise.all(staleKeys.map(function (key) {
      return caches.delete(key);
    }));
  }

  async function deleteBootPersistentCacheNamespace(cacheKey) {
    if (!supportsPersistentBootCache()) {
      return;
    }

    try {
      await caches.delete(getBootPersistentCacheName(cacheKey));
    } catch (error) {
      console.warn('[boot_download_helpers] persistent boot cache delete failed:', error);
    }
  }

  async function readPersistentBootDownload(cacheKey) {
    if (!supportsPersistentBootCache()) {
      return null;
    }

    try {
      const cacheName = getBootPersistentCacheName(cacheKey);
      await ensureBootPersistentCacheNamespace(cacheName);
      const cache = await caches.open(cacheName);
      let cachedResponse = await cache.match(cacheKey);
      if (!cachedResponse) {
        cachedResponse = await cache.match(getBootPartialCacheKey(cacheKey));
      }
      if (!cachedResponse) {
        return null;
      }

      const contentType = getHeader(cachedResponse.headers, 'content-type') || 'application/octet-stream';
      const resourceLength = parseTotalFromContentRange(getHeader(cachedResponse.headers, 'Content-Range'))
        ?? (Number.isFinite(Number(getHeader(cachedResponse.headers, 'X-Boot-Resource-Length')))
          ? Number(getHeader(cachedResponse.headers, 'X-Boot-Resource-Length'))
          : null);
      const totalBytes = Number.isFinite(Number(getHeader(cachedResponse.headers, 'X-Boot-Total-Bytes')))
        ? Number(getHeader(cachedResponse.headers, 'X-Boot-Total-Bytes'))
        : (resourceLength != null ? resourceLength : null);
      const bytes = new Uint8Array(await cachedResponse.arrayBuffer());
      const completeHeader = getHeader(cachedResponse.headers, 'X-Boot-Complete');
      const validator = getHeader(cachedResponse.headers, 'X-Boot-Validator')
        || getHeader(cachedResponse.headers, 'ETag')
        || getHeader(cachedResponse.headers, 'Last-Modified');
      const sha256 = normalizeSha256(getHeader(cachedResponse.headers, 'X-Boot-Sha256'));
      const inferredComplete = (
        completeHeader == null &&
        resourceLength != null &&
        bytes.byteLength > 0 &&
        bytes.byteLength === totalBytes &&
        totalBytes === resourceLength
      );

      return {
        complete: completeHeader === '1' || inferredComplete,
        bytes: bytes,
        contentType: contentType,
        totalBytes: totalBytes != null ? totalBytes : bytes.byteLength,
        resourceLength: resourceLength != null ? resourceLength : bytes.byteLength,
        validator: validator,
        sha256: sha256,
      };
    } catch (error) {
      console.warn('[boot_download_helpers] persistent boot cache read failed:', error);
      return null;
    }
  }

  function makeBootCacheBody(bodyParts) {
    if (!Array.isArray(bodyParts)) {
      if (!bodyParts) {
        return null;
      }
      return {
        body: bodyParts.slice ? bodyParts.slice(0) : bodyParts,
        length: bodyParts.byteLength || 0,
      };
    }

    const parts = [];
    let length = 0;
    for (const part of bodyParts) {
      if (!part || !part.byteLength) {
        continue;
      }
      parts.push(part);
      length += part.byteLength;
    }

    if (parts.length === 0) {
      return null;
    }

    return {
      body: new Blob(parts),
      length: length,
    };
  }

  async function writePersistentBootDownload(cacheKey, bodyParts, contentType, totalBytes, resourceLength, validator, complete, generation, sha256) {
    const cacheBody = makeBootCacheBody(bodyParts);
    if (!cacheBody || !supportsPersistentBootCache()) {
      return;
    }

    try {
      const cacheName = getBootPersistentCacheName(cacheKey);
      await ensureBootPersistentCacheNamespace(cacheName);
      const writeKey = complete ? cacheKey : getBootPartialCacheKey(cacheKey);
      const headers = new Headers();
      headers.set('Content-Type', contentType || 'application/octet-stream');
      headers.set('Content-Length', String(cacheBody.length));
      headers.set('X-Boot-Total-Bytes', String(Number.isFinite(totalBytes) ? totalBytes : cacheBody.length));
      headers.set('X-Boot-Resource-Length', String(Number.isFinite(resourceLength) ? resourceLength : cacheBody.length));
      headers.set('X-Boot-Complete', complete ? '1' : '0');
      if (Number.isFinite(generation)) {
        headers.set('X-Boot-Generation', String(generation));
      }
      if (sha256) {
        headers.set('X-Boot-Sha256', sha256);
      }
      if (validator) {
        headers.set('X-Boot-Validator', validator);
      }

      const response = new Response(cacheBody.body, { headers: headers });
      const cache = await caches.open(cacheName);
      await cache.put(writeKey, response);
      if (complete && typeof cache.delete === 'function') {
        await cache.delete(getBootPartialCacheKey(cacheKey));
      }
    } catch (error) {
      console.warn('[boot_download_helpers] persistent boot cache write failed:', error);
    }
  }

  async function deletePersistentBootPartialDownload(cacheKey) {
    if (!supportsPersistentBootCache()) {
      return;
    }

    try {
      const cacheName = getBootPersistentCacheName(cacheKey);
      const cache = await caches.open(cacheName);
      if (cache && typeof cache.delete === 'function') {
        await cache.delete(getBootPartialCacheKey(cacheKey));
      }
    } catch (error) {
      console.warn('[boot_download_helpers] persistent boot partial cache delete failed:', error);
    }
  }

  async function deletePersistentBootDownload(cacheKey) {
    if (!supportsPersistentBootCache()) {
      return;
    }

    try {
      const cacheName = getBootPersistentCacheName(cacheKey);
      const cache = await caches.open(cacheName);
      if (cache && typeof cache.delete === 'function') {
        await cache.delete(cacheKey);
        await cache.delete(getBootPartialCacheKey(cacheKey));
      }
    } catch (error) {
      console.warn('[boot_download_helpers] persistent boot cache entry delete failed:', error);
    }
  }

  function getAxios() {
    const client = typeof globalThis !== 'undefined' ? globalThis.axios : null;
    if (!client) {
      throw new Error('axios is not available');
    }
    return client;
  }

  async function validateCachedDownload(cachedCompletion, collectBytes, expectedBytes, expectedSha256, label) {
    if (!cachedCompletion || !cachedCompletion.complete) {
      return false;
    }

    if (
      Number.isFinite(expectedBytes) &&
      expectedBytes > 0 &&
      Number(cachedCompletion.totalBytes || cachedCompletion.resourceLength || 0) !== expectedBytes
    ) {
      console.warn('[boot_download_helpers] ignoring cached boot download with mismatched size:', {
        label: label,
        expectedBytes: expectedBytes,
        cachedBytes: cachedCompletion.totalBytes || cachedCompletion.resourceLength,
      });
      return false;
    }

    if (expectedSha256) {
      if (!cachedCompletion.bytes) {
        console.warn('[boot_download_helpers] ignoring cached boot download without bytes for hash validation:', {
          label: label,
        });
        return false;
      }

      const actualSha256 = await sha256Hex(cachedCompletion.bytes);
      if (actualSha256 !== expectedSha256) {
        console.warn('[boot_download_helpers] ignoring cached boot download with mismatched SHA-256:', {
          label: label,
          expectedSha256: expectedSha256,
          actualSha256: actualSha256,
        });
        return false;
      }

      cachedCompletion.sha256 = actualSha256;
    }

    if (!collectBytes) {
      return true;
    }

    return !!cachedCompletion.bytes;
  }

  async function isPersistentBootDownloadReady(cacheKey, options) {
    options = options || {};
    const cachedCompletion = await readPersistentBootDownload(cacheKey);
    const expectedBytes = Number.isFinite(options.totalBytesHint) && options.totalBytesHint > 0
      ? options.totalBytesHint
      : null;
    const expectedSha256 = normalizeSha256(options.expectedSha256 || options.sha256);
    return await validateCachedDownload(
      cachedCompletion,
      false,
      expectedBytes,
      expectedSha256,
      options.label || cacheKey,
    );
  }

  async function waitBeforeBootRetry(attempt, label, error, options) {
    options = options || {};
    const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 2000;
    const maxRetryDelayMs = Number.isFinite(options.maxRetryDelayMs) ? options.maxRetryDelayMs : 5000;
    const delayMs = Math.min(
      maxRetryDelayMs,
      retryDelayMs * Math.max(1, attempt),
    );

    if (typeof options.onRetryDelay === 'function') {
      options.onRetryDelay(delayMs, attempt, label, error);
    }

    await waitForOnlineOrTimeout(delayMs, options.abortSignal);
  }

  function createBootCacheWriter(options) {
    options = options || {};
    const cacheKey = String(options.cacheKey || '');
    const shouldKeepBytes = options.shouldKeepBytes !== false;
    const getChunks = typeof options.getChunks === 'function'
      ? options.getChunks
      : function () { return []; };
    const getContentType = typeof options.getContentType === 'function'
      ? options.getContentType
      : function () { return 'application/octet-stream'; };
    const getTotalBytes = typeof options.getTotalBytes === 'function'
      ? options.getTotalBytes
      : function () { return 0; };
    const getResourceLength = typeof options.getResourceLength === 'function'
      ? options.getResourceLength
      : function () { return null; };
    const getValidator = typeof options.getValidator === 'function'
      ? options.getValidator
      : function () { return null; };
    const getSha256 = typeof options.getSha256 === 'function'
      ? options.getSha256
      : function () { return null; };
    const minBytes = Number.isFinite(options.minBytes) && options.minBytes > 0
      ? options.minBytes
      : 512 * 1024;
    const minMs = Number.isFinite(options.minMs) && options.minMs > 0
      ? options.minMs
      : 1500;

    let flushTimer = null;
    let flushPromise = null;
    let dirty = false;
    let pendingComplete = false;
    let closed = false;
    let lastPersistedTotalBytes = 0;
    let lastPersistedAt = 0;
    let generation = 0;

    function canSchedule(force) {
      if (!shouldKeepBytes) {
        return false;
      }
      if (closed) {
        return false;
      }
      if (force) {
        return true;
      }
      const totalBytes = getTotalBytes();
      if (totalBytes - lastPersistedTotalBytes >= minBytes) {
        return true;
      }
      return (Date.now() - lastPersistedAt) >= minMs;
    }

    async function persistOnce(complete) {
      const chunks = getChunks();
      if (!chunks || chunks.length === 0) {
        return;
      }
      const snapshot = chunks.slice();
      const totalBytes = getTotalBytes();
      const resourceLength = getResourceLength();
      const validator = getValidator();
      const contentType = getContentType();
      const writeGeneration = generation;
      const sha256 = getSha256();

      await writePersistentBootDownload(
        cacheKey,
        snapshot,
        contentType,
        totalBytes,
        resourceLength,
        validator,
        complete,
        writeGeneration,
        sha256,
      );

      lastPersistedTotalBytes = totalBytes;
      lastPersistedAt = Date.now();
    }

    async function runFlushLoop() {
      if (flushPromise) {
        return flushPromise;
      }

      flushPromise = (async function () {
        try {
          while (dirty || pendingComplete) {
            const complete = pendingComplete;
            dirty = false;
            pendingComplete = false;
            await persistOnce(complete);
            if (complete) {
              closed = true;
              break;
            }
          }
        } catch (error) {
          console.warn('[boot_download_helpers] persistent boot cache write failed:', error);
        } finally {
          flushPromise = null;
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          if (dirty || pendingComplete) {
            schedule(false);
          }
        }
      })();

      return flushPromise;
    }

    function schedule(force) {
      if (!canSchedule(force)) {
        return;
      }

      dirty = true;
      if (!flushTimer && !flushPromise) {
        flushTimer = setTimeout(function () {
          flushTimer = null;
          void runFlushLoop();
        }, force ? 0 : minMs);
      }
    }

    async function flushNow(complete) {
      if (!shouldKeepBytes) {
        return;
      }

      if (complete) {
        pendingComplete = true;
      }
      dirty = true;

      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      await runFlushLoop();
      if (flushPromise) {
        await flushPromise;
      }
    }

    function reset() {
      generation += 1;
      closed = false;
      dirty = false;
      pendingComplete = false;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    }

    function prime(totalBytes) {
      lastPersistedTotalBytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
      lastPersistedAt = Date.now();
    }

    return {
      schedule: schedule,
      flushNow: flushNow,
      reset: reset,
      prime: prime,
    };
  }

  async function downloadResumableBytesWithFetch(url, init, options) {
    options = options || {};
    const label = options.label || 'resource';
    const collectBytes = options.collectBytes !== false;
    const initialBytesLoaded = Number.isFinite(options.initialBytesLoaded) && options.initialBytesLoaded > 0
      ? options.initialBytesLoaded
      : 0;
    const initialSeedBytes = options.initialSeedBytes instanceof Uint8Array
      ? options.initialSeedBytes
      : null;
    const cacheKey = normalizeBootUrl(url);
    const cacheBytesLimit = Number.isFinite(options.cacheBytesLimit) && options.cacheBytesLimit > 0
      ? options.cacheBytesLimit
      : 8 * 1024 * 1024;
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : 200;
    const idleMs = Number.isFinite(options.idleMs) ? options.idleMs : 25000;
    const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 2000;
    const maxRetryDelayMs = Number.isFinite(options.maxRetryDelayMs) ? options.maxRetryDelayMs : 5000;
    const abortSignal = options.abortSignal || null;
    const resumeValidator = typeof options.resumeValidator === 'string' && options.resumeValidator.trim()
      ? options.resumeValidator.trim()
      : null;
    const expectedSha256 = normalizeSha256(options.expectedSha256 || options.sha256);
    const strictRangeResume = options.strictRangeResume !== false;
    const useIfRange = options.useIfRange === true;
    const shouldKeepBytes = collectBytes || (
      Number.isFinite(options.totalBytesHint) &&
      options.totalBytesHint > 0 &&
      options.totalBytesHint <= cacheBytesLimit
    );

    const segmentsAcc = shouldKeepBytes
      ? (initialSeedBytes ? [initialSeedBytes] : [])
      : [];
    let transferBytesOffset = Math.max(
      initialBytesLoaded,
      initialSeedBytes ? initialSeedBytes.byteLength : 0,
    );
    let transferResourceLen =
      Number.isFinite(options.totalBytesHint) && options.totalBytesHint > 0
        ? options.totalBytesHint
        : null;
    let responseContentType = options.contentType || 'application/octet-stream';
    let lastError = null;
    let lastResponseValidator = resumeValidator;
    let completedSha256 = null;
    let activeLapChunks = [];
    let activeLapLoaded = 0;
    const partialCacheWriter = createBootCacheWriter({
      cacheKey: cacheKey,
      shouldKeepBytes: shouldKeepBytes,
      getChunks: function () {
        const chunks = segmentsAcc.slice();
        if (activeLapChunks && activeLapChunks.length > 0) {
          chunks.push(...activeLapChunks);
        }
        return chunks;
      },
      getContentType: function () {
        return responseContentType;
      },
      getTotalBytes: function () {
        return transferBytesOffset + activeLapLoaded;
      },
      getResourceLength: function () {
        return transferResourceLen;
      },
      getValidator: function () {
        return lastResponseValidator;
      },
      getSha256: function () {
        return completedSha256;
      },
      minBytes: options.partialPersistMinBytes,
      minMs: options.partialPersistMinMs,
    });
    partialCacheWriter.prime(transferBytesOffset);

    for (let lap = 0; lap < maxAttempts; lap += 1) {
      const attemptUrl = buildAttemptUrl(url, lap, transferBytesOffset);
      const hdr = headersToPlainObject(init && init.headers ? init.headers : undefined);
      if (lap > 0 || transferBytesOffset > 0) {
        hdr['Cache-Control'] = 'no-cache';
        hdr.Pragma = 'no-cache';
      }
      if (transferBytesOffset > 0) {
        hdr.Range = `bytes=${transferBytesOffset}-`;
        // Disabled by default. If-Range can legally turn a Range request into
        // full 200 OK when the validator does not match; immutable versioned
        // files are protected by manifest size + SHA-256 instead.
        if (useIfRange && lastResponseValidator) {
          hdr['If-Range'] = lastResponseValidator;
        }
      }

      let requestTimedOut = false;
      let idleTimer = null;
      let currentLapLoaded = 0;
      let response = null;
      const lapChunks = [];
      activeLapChunks = lapChunks;
      activeLapLoaded = 0;

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (abortSignal) {
        if (abortSignal.aborted) {
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const resetIdleTimer = () => {
        clearIdleTimer();
        if (idleMs > 0) {
          idleTimer = setTimeout(() => {
            requestTimedOut = true;
            controller.abort();
          }, idleMs);
        }
      };

      try {
        resetIdleTimer();
        if (typeof options.onProgress === 'function') {
          options.onProgress(transferBytesOffset, transferResourceLen, {
            attempt: lap + 1,
            label: label,
            phase: 'start',
          });
        }

        response = await window.fetch(attemptUrl, {
          method: 'GET',
          headers: hdr,
          signal: controller.signal,
          cache: (lap > 0 || transferBytesOffset > 0)
            ? 'no-store'
            : ((init && init.cache) || 'force-cache'),
          credentials: init && typeof init.withCredentials === 'boolean'
            ? (init.withCredentials ? 'include' : 'same-origin')
            : 'same-origin',
          priority: init && typeof init.priority === 'string'
            ? init.priority
            : undefined,
        });

        clearIdleTimer();
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort);
        }

        const headers = response.headers || {};
        const status = response.status;
        if (status === 416) {
          if (transferResourceLen != null && transferBytesOffset >= transferResourceLen) {
            break;
          }

          const err416 = new Error(`Could not load ${label}: HTTP 416`);
          err416.retriable = false;
          err416.httpResponse = response;
          throw err416;
        }

        if (status !== 200 && status !== 206) {
          const statusErr = new Error(`Failed to download ${label}: ${status}`);
          statusErr.retriable = false;
          statusErr.httpResponse = response;
          throw statusErr;
        }

        const contentRange = getHeader(headers, 'Content-Range');
        const parsedRange = parseRangeFromContentRange(contentRange);
        transferResourceLen = (parsedRange && parsedRange.total) ?? parseTotalFromContentRange(contentRange) ?? transferResourceLen;
        responseContentType = getHeader(headers, 'content-type') || responseContentType;
        lastResponseValidator = getHeader(headers, 'etag')
          || getHeader(headers, 'last-modified')
          || lastResponseValidator;

        if (transferBytesOffset > 0 && status === 200 && !contentRange) {
          if (strictRangeResume) {
            console.warn('[boot_download_helpers] server ignored Range request; retrying resume instead of accepting 200:', {
              label: label,
              attempt: lap + 1,
              url: url,
              resumeOffset: transferBytesOffset,
            });
            if (response.body && typeof response.body.cancel === 'function') {
              try {
                await response.body.cancel('range ignored');
              } catch (_) {
                // Best-effort cancellation only.
              }
            }
            activeLapChunks = [];
            activeLapLoaded = 0;
            partialCacheWriter.reset();
            const ignoredRangeErr = new Error(
              `Could not load ${label}: server ignored Range request at byte ${transferBytesOffset}`,
            );
            ignoredRangeErr.code = 'RANGE_IGNORED';
            ignoredRangeErr.retriable = true;
            ignoredRangeErr.httpResponse = response;
            throw ignoredRangeErr;
          }

          console.warn('[boot_download_helpers] server ignored Range request; accepting 200 OK as full restart:', {
            label: label,
            attempt: lap + 1,
            url: url,
            resumeOffset: transferBytesOffset,
          });
          activeLapChunks = [];
          activeLapLoaded = 0;
          segmentsAcc.length = 0;
          transferBytesOffset = 0;
          lastResponseValidator = null;
          partialCacheWriter.reset();
        }

        if (status === 206 && (!parsedRange || parsedRange.start !== transferBytesOffset)) {
          console.warn('[boot_download_helpers] unexpected Content-Range on resumed boot download; retrying without dropping partial cache:', {
            label: label,
            expectedStart: transferBytesOffset,
            contentRange: contentRange,
          });
          activeLapChunks = [];
          activeLapLoaded = 0;
          partialCacheWriter.reset();
          const rangeErr = new Error(`Could not load ${label}: unexpected Content-Range`);
          rangeErr.code = 'RANGE_MISMATCH';
          rangeErr.retriable = true;
          rangeErr.httpResponse = response;
          throw rangeErr;
        }

        const reader = response.body && typeof response.body.getReader === 'function'
          ? response.body.getReader()
          : null;

        if (reader) {
          while (true) {
            const next = await readStreamChunkWithAbort(reader, abortSignal);
            if (next.done) {
              break;
            }

            const chunk = bytesFromAxiosData(next.value);
            lapChunks.push(chunk);
            currentLapLoaded += chunk.byteLength;
            activeLapLoaded = currentLapLoaded;
            resetIdleTimer();
            partialCacheWriter.schedule(false);

            if (typeof options.onProgress === 'function') {
              options.onProgress(transferBytesOffset + currentLapLoaded, transferResourceLen, {
                attempt: lap + 1,
                label: label,
                phase: 'chunk',
              });
            }
          }
        } else {
          const bodyBytes = bytesFromAxiosData(await response.arrayBuffer());
          lapChunks.push(bodyBytes);
          currentLapLoaded += bodyBytes.byteLength;
          activeLapLoaded = currentLapLoaded;
          partialCacheWriter.schedule(false);

          if (typeof options.onProgress === 'function') {
            options.onProgress(transferBytesOffset + currentLapLoaded, transferResourceLen, {
              attempt: lap + 1,
              label: label,
              phase: 'chunk',
            });
          }
        }

        clearIdleTimer();
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort);
        }

        const bodyBytes = concatByteChunks(lapChunks);
        const nextTransferBytesOffset = transferBytesOffset + bodyBytes.byteLength;

        if (transferResourceLen != null && nextTransferBytesOffset < transferResourceLen) {
          const shortErr = new Error(`Could not load ${label}: response ended early`);
          shortErr.code = 'READ_IDLE_TIMEOUT';
          shortErr.retriable = true;
          throw shortErr;
        }

        if (shouldKeepBytes) {
          segmentsAcc.push(...lapChunks);
        }
        transferBytesOffset = nextTransferBytesOffset;
        activeLapChunks = [];
        activeLapLoaded = 0;
        partialCacheWriter.prime(transferBytesOffset);

        if (status === 200 && !contentRange) {
          console.info('[boot_download_helpers] accepted complete full 200 response:', {
            label: label,
            attempt: lap + 1,
            url: url,
            bytes: bodyBytes.byteLength,
          });
        }

        break;
      } catch (error) {
        clearIdleTimer();
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort);
        }

        lastError = error;

        const partialBytesThisLap = currentLapLoaded > 0 ? currentLapLoaded : 0;
        if (partialBytesThisLap > 0 && isTransientBootFetchError(error) && !(abortSignal && abortSignal.aborted)) {
          if (shouldKeepBytes && lapChunks.length > 0) {
            segmentsAcc.push(...lapChunks);
          }

          transferBytesOffset += partialBytesThisLap;
          activeLapChunks = [];
          activeLapLoaded = 0;
          await partialCacheWriter.flushNow(false);
          if (typeof options.onProgress === 'function') {
            options.onProgress(transferBytesOffset, transferResourceLen, {
              attempt: lap + 1,
              label: label,
              phase: 'retry',
            });
          }

          console.info('[boot_download_helpers] committed partial boot download before retry:', {
            label: label,
            attempt: lap + 1,
            url: url,
            bytes: partialBytesThisLap,
            totalBytes: transferBytesOffset,
          });
        }

        if (abortSignal && abortSignal.aborted) {
          if (shouldKeepBytes && lapChunks.length > 0) {
            segmentsAcc.push(...lapChunks);
          }
          activeLapChunks = [];
          activeLapLoaded = 0;
          await partialCacheWriter.flushNow(false);
          error.retriable = false;
          throw error;
        }

        if (requestTimedOut && isTransientBootFetchError(error)) {
          error.code = 'READ_IDLE_TIMEOUT';
          error.retriable = true;
        }

        if (error && error.retriable === false) {
          throw error;
        }

        if (!isTransientBootFetchError(error)) {
          console.warn('[boot_download_helpers] unexpected boot download error, retrying:', error);
        }

        if (lap + 1 >= maxAttempts) {
          throw error;
        }

        await waitBeforeBootRetry(lap + 1, label, error, {
          retryDelayMs: retryDelayMs,
          maxRetryDelayMs: maxRetryDelayMs,
          onRetryDelay: options.onRetryDelay,
        });
      }
    }

    if (transferResourceLen != null && transferBytesOffset < transferResourceLen) {
      throw new Error(
        'Could not load ' + label +
        ': only ' + transferBytesOffset + ' of ' + transferResourceLen + ' bytes were downloaded' +
        (lastError ? ' after retries' : ''),
      );
    }

    const bodyBytes = shouldKeepBytes ? concatByteChunks(segmentsAcc) : null;
    if (expectedSha256) {
      if (!bodyBytes) {
        throw new Error(`Could not validate ${label}: downloaded bytes were not retained`);
      }
      completedSha256 = await sha256Hex(bodyBytes);
      if (completedSha256 !== expectedSha256) {
        partialCacheWriter.reset();
        await deletePersistentBootDownload(cacheKey);
        completedBootDownloads.delete(cacheKey);
        if (initialSeedBytes && initialSeedBytes.byteLength > 0 && options._hashRestarted !== true) {
          console.warn('[boot_download_helpers] resumed boot download failed SHA-256 validation; retrying from byte 0:', {
            label: label,
            expectedSha256: expectedSha256,
            actualSha256: completedSha256,
          });
          return await downloadResumableBytesWithFetch(
            url,
            init,
            Object.assign({}, options, {
              initialBytesLoaded: 0,
              initialSeedBytes: null,
              resumeValidator: null,
              _hashRestarted: true,
            }),
          );
        }
        const hashErr = new Error(`Could not load ${label}: SHA-256 mismatch`);
        hashErr.retriable = false;
        hashErr.expectedSha256 = expectedSha256;
        hashErr.actualSha256 = completedSha256;
        throw hashErr;
      }
    }

    const result = {
      bytes: bodyBytes,
      contentType: responseContentType,
      totalBytes: transferBytesOffset,
      resourceLength: transferResourceLen,
      sha256: completedSha256,
    };

    completedBootDownloads.set(cacheKey, {
      complete: true,
      bytes: bodyBytes ? bodyBytes.slice(0) : null,
      contentType: responseContentType,
      totalBytes: transferBytesOffset,
      resourceLength: transferResourceLen,
      sha256: completedSha256,
    });

    if (bodyBytes) {
      activeLapChunks = [];
      activeLapLoaded = 0;
      await partialCacheWriter.flushNow(true);
      await deletePersistentBootPartialDownload(cacheKey);
    }

    return result;
  }

  async function downloadResumableBytes(url, init, options) {
    options = options || {};
    const label = options.label || 'resource';
    const collectBytes = options.collectBytes !== false;
    const initialBytesLoaded = Number.isFinite(options.initialBytesLoaded) && options.initialBytesLoaded > 0
      ? options.initialBytesLoaded
      : 0;
    const cacheBytesLimit = Number.isFinite(options.cacheBytesLimit) && options.cacheBytesLimit > 0
      ? options.cacheBytesLimit
      : 8 * 1024 * 1024;
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : 200;
    const idleMs = Number.isFinite(options.idleMs) ? options.idleMs : 25000;
    const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 2000;
    const maxRetryDelayMs = Number.isFinite(options.maxRetryDelayMs) ? options.maxRetryDelayMs : 5000;
    const abortSignal = options.abortSignal || null;
    const shouldKeepBytes = collectBytes || (
      Number.isFinite(options.totalBytesHint) &&
      options.totalBytesHint > 0 &&
      options.totalBytesHint <= cacheBytesLimit
    );
    const expectedBytes = Number.isFinite(options.totalBytesHint) && options.totalBytesHint > 0
      ? options.totalBytesHint
      : null;
    const expectedSha256 = normalizeSha256(options.expectedSha256 || options.sha256);
    const strictRangeResume = options.strictRangeResume !== false;
    const useIfRange = options.useIfRange === true;
    const useFetchStreaming =
      typeof window !== 'undefined' &&
      typeof window.fetch === 'function';

    const cacheKey = normalizeBootUrl(url);
    const cachedCompletion = completedBootDownloads.get(cacheKey);
    if (await validateCachedDownload(cachedCompletion, collectBytes, expectedBytes, expectedSha256, label)) {
      console.info('[boot_download_helpers] reusing completed boot download:', {
        label: label,
        url: url,
        totalBytes: cachedCompletion.totalBytes,
      });
      return {
        bytes: collectBytes && cachedCompletion.bytes
          ? cachedCompletion.bytes.slice(0)
          : null,
        contentType: cachedCompletion.contentType,
        totalBytes: cachedCompletion.totalBytes,
        resourceLength: cachedCompletion.resourceLength,
        sha256: cachedCompletion.sha256 || expectedSha256 || null,
      };
    }
    if (cachedCompletion && cachedCompletion.complete) {
      completedBootDownloads.delete(cacheKey);
    }

    const persistentCompletion = await readPersistentBootDownload(cacheKey);
    const canReusePersistent = await validateCachedDownload(
      persistentCompletion,
      collectBytes,
      expectedBytes,
      expectedSha256,
      label,
    );
    if (canReusePersistent) {
      console.info('[boot_download_helpers] reusing persistent boot download:', {
        label: label,
        url: url,
        totalBytes: persistentCompletion.totalBytes,
      });

      completedBootDownloads.set(cacheKey, {
        complete: true,
        bytes: persistentCompletion.bytes ? persistentCompletion.bytes.slice(0) : null,
        contentType: persistentCompletion.contentType,
        totalBytes: persistentCompletion.totalBytes,
        resourceLength: persistentCompletion.resourceLength,
        sha256: persistentCompletion.sha256 || expectedSha256 || null,
      });

      return {
        bytes: collectBytes && persistentCompletion.bytes
          ? persistentCompletion.bytes.slice(0)
          : null,
        contentType: persistentCompletion.contentType,
        totalBytes: persistentCompletion.totalBytes,
        resourceLength: persistentCompletion.resourceLength,
        sha256: persistentCompletion.sha256 || expectedSha256 || null,
      };
    }

    if (persistentCompletion && persistentCompletion.complete && !canReusePersistent) {
      await deletePersistentBootDownload(cacheKey);
    }

    const canResumePersistent = persistentCompletion && !persistentCompletion.complete;
    const persistentResumeBytes = canResumePersistent && persistentCompletion.bytes && persistentCompletion.bytes.byteLength > 0
      ? persistentCompletion.bytes
      : null;
    const persistentResumeValidator = canResumePersistent && persistentCompletion && persistentCompletion.validator
      ? persistentCompletion.validator
      : null;
    let persistentResumeOffset = persistentResumeBytes ? persistentResumeBytes.byteLength : initialBytesLoaded;
    if (expectedSha256 && !persistentResumeBytes && persistentResumeOffset > 0) {
      console.warn('[boot_download_helpers] ignoring UI-only resume offset because hash validation needs cached seed bytes:', {
        label: label,
        resumeOffset: persistentResumeOffset,
      });
      persistentResumeOffset = 0;
    }

    const inflightDownload = inflightBootDownloads.get(cacheKey);
    if (inflightDownload) {
      console.info('[boot_download_helpers] reusing inflight boot download:', {
        label: label,
        url: url,
      });
      return inflightDownload.then(function (result) {
        if (collectBytes && result.bytes) {
          return {
            bytes: result.bytes.slice(0),
            contentType: result.contentType,
            totalBytes: result.totalBytes,
            resourceLength: result.resourceLength,
            sha256: result.sha256 || null,
          };
        }

        return {
          bytes: null,
          contentType: result.contentType,
          totalBytes: result.totalBytes,
          resourceLength: result.resourceLength,
          sha256: result.sha256 || null,
        };
      });
    }

    const downloadPromise = (async function () {
      if (useFetchStreaming) {
        return await downloadResumableBytesWithFetch(url, init, Object.assign({}, options, {
          initialBytesLoaded: persistentResumeOffset,
          initialSeedBytes: persistentResumeBytes,
          resumeValidator: persistentResumeValidator,
        }));
      }

      const segmentsAcc = persistentResumeBytes ? [persistentResumeBytes] : [];
      let transferBytesOffset = persistentResumeOffset;
      let transferResourceLen =
        Number.isFinite(options.totalBytesHint) && options.totalBytesHint > 0
          ? options.totalBytesHint
          : null;
      let responseContentType = options.contentType || 'application/octet-stream';
      let lastResponseValidator = persistentResumeValidator;
      let lastError = null;
      const axios = getAxios();

      for (let lap = 0; lap < maxAttempts; lap += 1) {
        const attemptUrl = buildAttemptUrl(url, lap, transferBytesOffset);
        const hdr = headersToPlainObject(init && init.headers ? init.headers : undefined);
        if (lap > 0 || transferBytesOffset > 0) {
          hdr['Cache-Control'] = 'no-cache';
          hdr.Pragma = 'no-cache';
        }
        if (transferBytesOffset > 0) {
          hdr.Range = `bytes=${transferBytesOffset}-`;
          // Disabled by default. If-Range can legally turn a Range request into
          // full 200 OK when the validator does not match; immutable versioned
          // files are protected by manifest size + SHA-256 instead.
          if (useIfRange && lastResponseValidator) {
            hdr['If-Range'] = lastResponseValidator;
          }
          }

        let requestTimedOut = false;
        let idleTimer = null;
        let currentLapLoaded = 0;
        let response = null;

        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (abortSignal) {
          if (abortSignal.aborted) {
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        const clearIdleTimer = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        };

        const resetIdleTimer = () => {
          clearIdleTimer();
          if (idleMs > 0) {
            idleTimer = setTimeout(() => {
              requestTimedOut = true;
              controller.abort();
            }, idleMs);
          }
        };

        try {
          resetIdleTimer();
          if (typeof options.onProgress === 'function') {
            options.onProgress(transferBytesOffset, transferResourceLen, {
              attempt: lap + 1,
              label: label,
              phase: 'start',
            });
          }

          response = await axios.request({
            url: attemptUrl,
            method: 'get',
            responseType: 'arraybuffer',
            headers: hdr,
            signal: controller.signal,
            withCredentials: init && typeof init.withCredentials === 'boolean'
              ? init.withCredentials
              : undefined,
            onDownloadProgress: function (evt) {
              const loaded = Number.isFinite(evt && evt.loaded) ? evt.loaded : 0;
              currentLapLoaded = loaded;
              resetIdleTimer();

              if (typeof options.onProgress === 'function') {
                options.onProgress(transferBytesOffset + currentLapLoaded, transferResourceLen, {
                  attempt: lap + 1,
                  label: label,
                  phase: 'chunk',
                });
              }
            },
          });

          clearIdleTimer();
          if (abortSignal) {
            abortSignal.removeEventListener('abort', onAbort);
          }

          const headers = response.headers || {};
          const status = response.status;
          if (status === 416) {
            if (transferResourceLen != null && transferBytesOffset >= transferResourceLen) {
              break;
            }

            const err416 = new Error(`Could not load ${label}: HTTP 416`);
            err416.retriable = false;
            err416.httpResponse = response;
            throw err416;
          }

          if (status !== 200 && status !== 206) {
            const statusErr = new Error(`Failed to download ${label}: ${status}`);
            statusErr.retriable = false;
            statusErr.httpResponse = response;
            throw statusErr;
          }

          const contentRange = getHeader(headers, 'Content-Range');
          transferResourceLen = parseTotalFromContentRange(contentRange) ?? transferResourceLen;
          responseContentType = getHeader(headers, 'content-type') || responseContentType;
          lastResponseValidator = getHeader(headers, 'etag')
            || getHeader(headers, 'last-modified')
            || lastResponseValidator;

          if (transferBytesOffset > 0 && status === 200 && !contentRange) {
            if (strictRangeResume) {
              console.warn('[boot_download_helpers] server ignored Range request; retrying resume instead of accepting 200:', {
                label: label,
                attempt: lap + 1,
                url: url,
                resumeOffset: transferBytesOffset,
              });
              const ignoredRangeErr = new Error(
                `Could not load ${label}: server ignored Range request at byte ${transferBytesOffset}`,
              );
              ignoredRangeErr.code = 'RANGE_IGNORED';
              ignoredRangeErr.retriable = true;
              ignoredRangeErr.httpResponse = response;
              throw ignoredRangeErr;
            }

            console.warn('[boot_download_helpers] server ignored Range request; accepting 200 OK as full restart:', {
              label: label,
              attempt: lap + 1,
              url: url,
              resumeOffset: transferBytesOffset,
            });
            segmentsAcc.length = 0;
            transferBytesOffset = 0;
            lastResponseValidator = null;
          }

          const bodyBytes = bytesFromAxiosData(response.data);

          if (typeof options.onProgress === 'function') {
            options.onProgress(transferBytesOffset, transferResourceLen, {
              attempt: lap + 1,
              label: label,
              phase: 'whole',
            });
          }

          if (shouldKeepBytes) {
            segmentsAcc.push(bodyBytes);
          }
          transferBytesOffset += bodyBytes.byteLength;

          if (status === 200 && !contentRange) {
            console.info('[boot_download_helpers] accepted full 200 response:', {
              label: label,
              attempt: lap + 1,
              url: url,
              bytes: bodyBytes.byteLength,
            });
          }

          if (transferResourceLen != null && transferBytesOffset < transferResourceLen) {
            const shortErr = new Error(`Could not load ${label}: response ended early`);
            shortErr.code = 'READ_IDLE_TIMEOUT';
            shortErr.retriable = true;
            throw shortErr;
          }

          break;
        } catch (error) {
          clearIdleTimer();
          if (abortSignal) {
            abortSignal.removeEventListener('abort', onAbort);
          }

          lastError = error;

          const partialBytesThisLap = currentLapLoaded > 0 ? currentLapLoaded : 0;
          if (partialBytesThisLap > 0 && isTransientBootFetchError(error) && !(abortSignal && abortSignal.aborted)) {
            transferBytesOffset += partialBytesThisLap;
            if (typeof options.onProgress === 'function') {
              options.onProgress(transferBytesOffset, transferResourceLen, {
                attempt: lap + 1,
                label: label,
                phase: 'retry',
              });
            }

            console.info('[boot_download_helpers] committed partial boot download before retry:', {
              label: label,
              attempt: lap + 1,
              url: url,
              bytes: partialBytesThisLap,
              totalBytes: transferBytesOffset,
            });
          }

          if (abortSignal && abortSignal.aborted) {
            if (shouldKeepBytes && segmentsAcc.length > 0) {
              await writePersistentBootDownload(
                cacheKey,
                segmentsAcc,
                responseContentType,
                transferBytesOffset,
                transferResourceLen,
                lastResponseValidator,
                false,
              );
            }
            error.retriable = false;
            throw error;
          }

          if (requestTimedOut && isTransientBootFetchError(error)) {
            error.code = 'READ_IDLE_TIMEOUT';
            error.retriable = true;
          }

          if (error && error.retriable === false) {
            throw error;
          }

          if (!isTransientBootFetchError(error)) {
            console.warn('[boot_download_helpers] unexpected boot download error, retrying:', error);
          }

          if (lap + 1 >= maxAttempts) {
            throw error;
          }

          await waitBeforeBootRetry(lap + 1, label, error, {
            retryDelayMs: retryDelayMs,
            maxRetryDelayMs: maxRetryDelayMs,
            onRetryDelay: options.onRetryDelay,
          });
        }
      }

      if (transferResourceLen != null && transferBytesOffset < transferResourceLen) {
        throw new Error(
          'Could not load ' + label +
          ': only ' + transferBytesOffset + ' of ' + transferResourceLen + ' bytes were downloaded' +
          (lastError ? ' after retries' : ''),
        );
      }

      const bodyBytes = shouldKeepBytes ? concatByteChunks(segmentsAcc) : null;
      let completedSha256 = null;
      if (expectedSha256) {
        if (!bodyBytes) {
          throw new Error(`Could not validate ${label}: downloaded bytes were not retained`);
        }

        completedSha256 = await sha256Hex(bodyBytes);
        if (completedSha256 !== expectedSha256) {
          await deletePersistentBootDownload(cacheKey);
          completedBootDownloads.delete(cacheKey);
          const hashErr = new Error(`Could not load ${label}: SHA-256 mismatch`);
          hashErr.retriable = false;
          hashErr.expectedSha256 = expectedSha256;
          hashErr.actualSha256 = completedSha256;
          throw hashErr;
        }
      }

      const result = {
        bytes: bodyBytes,
        contentType: responseContentType,
        totalBytes: transferBytesOffset,
        resourceLength: transferResourceLen,
        sha256: completedSha256,
      };

      completedBootDownloads.set(cacheKey, {
        complete: true,
        bytes: bodyBytes ? bodyBytes.slice(0) : null,
        contentType: responseContentType,
        totalBytes: transferBytesOffset,
        resourceLength: transferResourceLen,
        sha256: completedSha256,
      });

      if (bodyBytes) {
        await writePersistentBootDownload(
          cacheKey,
          bodyBytes,
          responseContentType,
          transferBytesOffset,
          transferResourceLen,
          lastResponseValidator,
          true,
          undefined,
          completedSha256,
        );
      }

      return result;
    })();

    inflightBootDownloads.set(cacheKey, downloadPromise);
    try {
      return await downloadPromise;
    } finally {
      if (inflightBootDownloads.get(cacheKey) === downloadPromise) {
        inflightBootDownloads.delete(cacheKey);
      }
    }
  }

  return {
    bootSleep: bootSleep,
    isTransientBootFetchError: isTransientBootFetchError,
    waitForOnlineOrTimeout: waitForOnlineOrTimeout,
    parseTotalFromContentRange: parseTotalFromContentRange,
    concatByteChunks: concatByteChunks,
    gunzipArrayBuffer: gunzipArrayBuffer,
    waitBeforeBootRetry: waitBeforeBootRetry,
    readPersistentBootDownload: readPersistentBootDownload,
    isPersistentBootDownloadReady: isPersistentBootDownloadReady,
    cleanupStaleBootPersistentCacheNamespaces: cleanupStaleBootPersistentCacheNamespaces,
    deleteBootPersistentCacheNamespace: deleteBootPersistentCacheNamespace,
    deletePersistentBootDownload: deletePersistentBootDownload,
    downloadResumableBytes: downloadResumableBytes,
  };
});
