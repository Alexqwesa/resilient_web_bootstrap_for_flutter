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


test('entrypoints match Flutter build config exactly, including hashed wasm and runtime paths', () => {
  const base = 'https://example.test/simops/version/A/';
  const config = {builds: [
    {mainJsPath: 'main.abcd1234.dart.js'},
    {mainWasmPath: 'app.1234abcd.wasm', jsSupportRuntimePath: 'runtime.abcd1234.mjs'},
  ]};
  for (const name of ['main.abcd1234.dart.js', 'app.1234abcd.wasm', 'runtime.abcd1234.mjs']) {
    assert.equal(helpers.isTrackedAppEntrypointRequest(base + name + '?v=1', base, base, config), true);
  }
  assert.equal(helpers.isTrackedAppEntrypointRequest(base + 'main.dart.js', base, base, config), false);
  assert.equal(helpers.isTrackedAppEntrypointRequest('https://other.test/main.abcd1234.dart.js', base, base, config), false);
});

test('content-hash templates preserve Flutter injection and pass hardcoded entrypoint validation', () => {
  const fs = require('node:fs');
  const directory = path.join(__dirname, '..', 'lib', 'templates', 'web');
  for (const name of ['index.html', 'flutter_bootstrap.js']) {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.equal(source.includes('main.dart.js'), false);
    assert.equal(source.includes('loadEntrypoint'), false);
  }
  const bootstrap = fs.readFileSync(path.join(directory, 'flutter_bootstrap.js'), 'utf8');
  assert.ok(bootstrap.includes('{{flutter_js}}'));
  assert.ok(bootstrap.includes('{{flutter_build_config}}'));
});
