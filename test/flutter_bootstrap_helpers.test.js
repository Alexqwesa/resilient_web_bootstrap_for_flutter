const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const helpers = require(path.join(
  __dirname,
  '..',
  'lib',
  'templates',
  'web',
  'flutter_bootstrap_helpers.js',
));

test('chooseCanvasKitBase selects chromium variant only for crossOriginIsolated', () => {
  assert.equal(
    helpers.chooseCanvasKitBase({
      buildBase: '/version/202604221530/',
      crossOriginIsolated: true,
    }),
    '/version/202604221530/canvaskit/chromium/',
  );

  assert.equal(
    helpers.chooseCanvasKitBase({
      buildBase: '/version/202604221530/',
      crossOriginIsolated: false,
    }),
    '/version/202604221530/canvaskit/',
  );
});

test('resolveBuildBase prefers injected build and can infer from script url', () => {
  assert.deepEqual(
    helpers.resolveBuildBase({
      injectedBuild: '202604221530',
      scriptSrc: 'https://host/version/old/flutter_bootstrap.js',
    }),
    { build: '202604221530', base: '/version/202604221530/' },
  );

  assert.deepEqual(
    helpers.resolveBuildBase({
      scriptSrc: 'https://host/version/202604221531/flutter_bootstrap.js',
    }),
    { build: '202604221531', base: '/version/202604221531/' },
  );
});

test('inferBootstrapScriptSrc prefers currentScript and falls back to the last bootstrap script', () => {
  assert.equal(
    helpers.inferBootstrapScriptSrc({
      currentScript: { src: 'https://host/version/202604221530/flutter_bootstrap.js' },
      getElementsByTagName() {
        return [];
      },
    }),
    'https://host/version/202604221530/flutter_bootstrap.js',
  );

  assert.equal(
    helpers.inferBootstrapScriptSrc({
      currentScript: null,
      getElementsByTagName() {
        return [
          { src: 'https://host/other.js' },
          { src: 'https://host/version/202604221531/flutter_bootstrap.js' },
        ];
      },
    }),
    'https://host/version/202604221531/flutter_bootstrap.js',
  );
});

test('isTrackedCanvasKitWasmRequest matches absolute request urls against relative base', () => {
  const absoluteCanvasKitBase = helpers.toAbsoluteUrl(
    '/version/202604221530/canvaskit/',
    'https://example.com/app/index.html',
  );

  assert.equal(
    helpers.isTrackedCanvasKitWasmRequest(
      'https://example.com/version/202604221530/canvaskit/canvaskit.wasm',
      absoluteCanvasKitBase,
      'https://example.com/app/index.html',
    ),
    true,
  );

  assert.equal(
    helpers.isTrackedCanvasKitWasmRequest(
      'https://example.com/version/202604221530/canvaskit/chromium/canvaskit.js',
      absoluteCanvasKitBase,
      'https://example.com/app/index.html',
    ),
    false,
  );
});

test('isTrackedAppEntrypointRequest matches main app bundle urls', () => {
  const absoluteBuildBase = helpers.toAbsoluteUrl(
    '/version/202604221530/',
    'https://example.com/index.html',
  );

  assert.equal(
    helpers.isTrackedAppEntrypointRequest(
      'https://example.com/version/202604221530/main.dart.js',
      absoluteBuildBase,
      'https://example.com/index.html',
    ),
    true,
  );

  assert.equal(
    helpers.isTrackedAppEntrypointRequest(
      'https://example.com/version/202604221530/main_module.bootstrap.js',
      absoluteBuildBase,
      'https://example.com/index.html',
    ),
    true,
  );

  assert.equal(
    helpers.isTrackedAppEntrypointRequest(
      'https://example.com/version/202604221530/assets/FontManifest.json',
      absoluteBuildBase,
      'https://example.com/index.html',
    ),
    false,
  );
});
