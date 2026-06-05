const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appUpdateTemplatePath = path.join(
  __dirname,
  '..',
  'lib',
  'templates',
  'web',
  'app_update.js',
);

function makeClassList() {
  const values = new Set();

  return {
    add(...names) {
      for (const name of names) {
        values.add(name);
      }
    },
    remove(...names) {
      for (const name of names) {
        values.delete(name);
      }
    },
    contains(name) {
      return values.has(name);
    },
    toString() {
      return Array.from(values).join(' ');
    },
  };
}

function makeStyle() {
  const values = Object.create(null);

  return {
    setProperty(name, value) {
      values[name] = value;
    },
    removeProperty(name) {
      delete values[name];
    },
    getPropertyValue(name) {
      return values[name] || '';
    },
  };
}

function makeEventTarget() {
  const listeners = new Map();

  return {
    addEventListener(type, callback, options) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push({ callback, once: !!(options && options.once) });
    },
    removeEventListener(type, callback) {
      const arr = listeners.get(type);
      if (!arr) return;
      listeners.set(
        type,
        arr.filter(entry => entry.callback !== callback),
      );
    },
    dispatchEvent(event) {
      const arr = listeners.get(event.type);
      if (!arr || arr.length === 0) {
        return true;
      }

      listeners.set(
        event.type,
        arr.filter(entry => {
          try {
            entry.callback.call(this, event);
          } catch (error) {
            throw error;
          }
          return !entry.once;
        }),
      );

      return true;
    },
  };
}

function makeElement(tagName, documentStore) {
  const upper = String(tagName || '').toUpperCase();
  const listeners = new Map();
  const element = {
    tagName: upper,
    id: '',
    classList: makeClassList(),
    style: makeStyle(),
    textContent: '',
    disabled: false,
    value: 0,
    offsetHeight: upper === 'DIV' ? 40 : 0,
    parentNode: null,
    _innerHTML: '',
    _src: '',
    setAttribute(name, value) {
      if (name === 'src') {
        this.src = value;
        return;
      }
      this[name] = value;
    },
    getAttribute(name) {
      if (name === 'src') {
        return this.src;
      }
      return this[name];
    },
    addEventListener(type, callback, options) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push({ callback, once: !!(options && options.once) });
    },
    dispatchEvent(event) {
      const arr = listeners.get(event.type);
      if (!arr || arr.length === 0) {
        return true;
      }

      listeners.set(
        event.type,
        arr.filter(entry => {
          entry.callback.call(this, event);
          return !entry.once;
        }),
      );

      return true;
    },
    appendChild(child) {
      child.parentNode = this;
      return child;
    },
  };

  Object.defineProperty(element, 'src', {
    get() {
      return this._src;
    },
    set(value) {
      this._src = String(value);
    },
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(element, 'innerHTML', {
    get() {
      return this._innerHTML;
    },
    set(value) {
      this._innerHTML = String(value);
      if (this.id === 'background-update-bar') {
        const ids = [
          'background-update-top-row',
          'background-update-text',
          'background-update-percent',
          'background-update-button',
          'background-update-hide-button',
          'background-update-progress',
        ];

        for (const id of ids) {
          if (!documentStore.has(id)) {
            const child = makeElement(id === 'background-update-progress' ? 'progress' : 'div', documentStore);
            child.id = id;
            if (id === 'background-update-button' || id === 'background-update-hide-button') {
              child.tagName = 'BUTTON';
            }
            if (id === 'background-update-progress') {
              child.tagName = 'PROGRESS';
            }
            documentStore.set(id, child);
          }
        }
      }
    },
    enumerable: true,
    configurable: true,
  });

  return element;
}

function makeDocument(context) {
  const store = new Map();
  const head = makeElement('head', store);
  const body = makeElement('body', store);
  const html = makeElement('html', store);

  const document = {
    readyState: 'complete',
    head,
    body,
    documentElement: html,
    currentScript: null,
    getElementById(id) {
      return store.get(id) || null;
    },
    getElementsByTagName(tagName) {
      if (String(tagName).toLowerCase() === 'script') {
        return Array.from(store.values()).filter(node => node.tagName === 'SCRIPT');
      }
      return [];
    },
    createElement(tagName) {
      const node = makeElement(tagName, store);
      if (node.tagName === 'SCRIPT') {
        node.onload = null;
        node.onerror = null;
      }
      return node;
    },
    addEventListener: (...args) => context.addEventListener(...args),
    removeEventListener: (...args) => context.removeEventListener(...args),
    dispatchEvent: (...args) => context.dispatchEvent(...args),
  };

  const originalAppendChild = body.appendChild.bind(body);
  body.appendChild = function appendChild(node) {
    if (node.id) {
      store.set(node.id, node);
    }

    if (node.tagName === 'SCRIPT' && String(node.src || '').startsWith('blob:test:')) {
      queueMicrotask(async () => {
        const blob = context.__blobStore.get(node.src);
        if (!blob) {
          if (typeof node.onerror === 'function') {
            node.onerror(new Error(`Missing blob for ${node.src}`));
          }
          return;
        }

        const bytes = new Uint8Array(await blob.arrayBuffer());
        const source = Buffer.from(bytes).toString('utf8');
        vm.runInContext(source, context, { filename: node.src });
        if (typeof node.onload === 'function') {
          node.onload();
        }
      });
    }

    return originalAppendChild(node);
  };

  const originalHeadAppendChild = head.appendChild.bind(head);
  head.appendChild = function appendChild(node) {
    if (node.id) {
      store.set(node.id, node);
    }
    return originalHeadAppendChild(node);
  };

  return { document, store };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise(resolve => setImmediate(resolve));
  }
}

function makeManifest(version, filePrefix) {
  const base = `/version/${version}/`;
  return {
    version,
    base,
    files: [
      {
        path: 'app_update.js',
        gzPath: `${filePrefix}app_update.js.gz`,
        gzSize: 111,
      },
      {
        path: 'flutter_bootstrap.js',
        gzPath: `${filePrefix}flutter_bootstrap.js.gz`,
        gzSize: 222,
      },
      {
        path: 'main.dart.js',
        gzPath: `${filePrefix}main.dart.js.gz`,
        gzSize: 333,
      },
      {
        path: 'canvaskit/canvaskit.wasm',
        gzPath: `${filePrefix}canvaskit/canvaskit.wasm.gz`,
        gzSize: 444,
      },
    ],
  };
}

function makeHarness({
  latestManifests,
  bootManifest,
  savedManifest,
  initialLastGoodManifest,
  nextManifest,
  bootCacheState,
  runBackgroundTimers = false,
  versionPinned = false,
  pinnedManifest,
  rootLatestFails = false,
} = {}) {
  const context = makeEventTarget();
  const blobStore = new Map();
  const downloadCalls = [];
  const manifestCalls = [];
  let rootManifestCallCount = 0;
  const cleanupCalls = [];
  const reloadCalls = [];
  let timeoutSeq = 0;
  const cancelledTimeouts = new Set();

  context.__blobStore = blobStore;
  context.console = console;
  context.queueMicrotask = queueMicrotask;
  context.setImmediate = setImmediate;
  context.Buffer = Buffer;
  context.Promise = Promise;
  context.Array = Array;
  context.Object = Object;
  context.String = String;
  context.Number = Number;
  context.Boolean = Boolean;
  context.Uint8Array = Uint8Array;
  context.ArrayBuffer = ArrayBuffer;
  context.Blob = Blob;
  context.AbortController = class TestAbortController {
    constructor() {
      this.signal = {
        aborted: false,
        addEventListener() {},
        removeEventListener() {},
      };
    }

    abort() {
      this.signal.aborted = true;
    }
  };
  context.Date = Date;
  context.Event = class TestEvent {
    constructor(type) {
      this.type = type;
    }
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  context.navigator = { onLine: true };
  context.location = {
    href: versionPinned
      ? 'https://example.test/version/202605141110/index.html'
      : 'https://example.test/index.html',
    pathname: versionPinned
      ? '/version/202605141110/index.html'
      : '/index.html',
    origin: 'https://example.test',
    reload() {
      reloadCalls.push(Date.now());
    },
  };

  if (versionPinned) {
    context.__resilientVersionPinned = true;
    context.__resilientAssetBase = '/version/202605141110/';
    context.resilientAssetUrl = function(relativePath) {
      const cleanPath = String(relativePath || '').replace(/^\/+/, '');
      return `https://example.test/version/202605141110/${cleanPath}`;
    };
  }
  context.URL = class TestURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:test:${blobStore.size + 1}`;
      blobStore.set(url, blob);
      return url;
    }

    static revokeObjectURL(url) {
      blobStore.delete(url);
    }
  };
  context.localStorage = {
    _map: new Map(),
    getItem(key) {
      return this._map.has(key) ? this._map.get(key) : null;
    },
    setItem(key, value) {
      this._map.set(key, String(value));
    },
    removeItem(key) {
      this._map.delete(key);
    },
    clear() {
      this._map.clear();
    },
  };
  context.window = context;
  context.setTimeout = function setTimeoutMock(fn, ms) {
    const id = ++timeoutSeq;
    if (!runBackgroundTimers && Number(ms) >= 5000) {
      return id;
    }
    queueMicrotask(() => {
      if (!cancelledTimeouts.has(id)) {
        fn();
      }
    });
    return id;
  };
  context.clearTimeout = function clearTimeoutMock(id) {
    cancelledTimeouts.add(id);
  };
  context.requestAnimationFrame = function requestAnimationFrameMock(fn) {
    return context.setTimeout(() => fn(Date.now()), 0);
  };
  context.cancelAnimationFrame = function cancelAnimationFrameMock(id) {
    context.clearTimeout(id);
  };

  const { document } = makeDocument(context);
  context.document = document;
  const defaultBootVersion = versionPinned ? '202605141110' : '202605141110';
  document.currentScript = {
    src: `https://example.test/version/${defaultBootVersion}/app_update.js`,
  };

  const bootstrapSource = Buffer.from(
    `
window.__BOOTSTRAP_SCRIPT_RAN = true;
_flutter.loader.load({
  config: {
    renderer: 'canvaskit',
    canvasKitBaseUrl: '/version/BOOT/canvaskit/'
  },
  onEntrypointLoaded: async function (engineInitializer) {
    window.__ON_ENTRYPOINT_LOADED = true;
    const appRunner = await engineInitializer.initializeEngine({ boot: true });
    window.__INITIALIZE_ENGINE_DONE = true;
    await appRunner.runApp();
    window.__RUN_APP_DONE = true;
    await new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
    window.dispatchEvent(new Event('flutter-first-frame'));
  }
});
`,
    'utf8',
  );

  context.BootDownloadHelpers = {
    async downloadResumableBytes(url) {
      downloadCalls.push(url);
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        contentType: 'application/gzip',
        totalBytes: 4,
        resourceLength: 4,
      };
    },
    async readPersistentBootDownload(url) {
      const entry = bootCacheState && bootCacheState.get(String(url));
      if (!entry) {
        return null;
      }

      return entry;
    },
    async cleanupStaleBootPersistentCacheNamespaces(url) {
      cleanupCalls.push(String(url));
    },
    async deleteBootPersistentCacheNamespace(url) {
      cleanupCalls.push(`delete:${String(url)}`);
    },
    async gunzipArrayBuffer() {
      return bootstrapSource.buffer.slice(
        bootstrapSource.byteOffset,
        bootstrapSource.byteOffset + bootstrapSource.byteLength,
      );
    },
  };

  context._flutter = {
    loader: {
      load(options) {
        context.__LOADER_LOAD_CALLED = true;
        context.__LOADER_CONFIG = options.config;
        queueMicrotask(async () => {
          context.__ENGINE_INITIALIZER_CALLED = true;
          await options.onEntrypointLoaded({
            initializeEngine: async function initializeEngine(cfg) {
              context.__ENGINE_INITIALIZE_CONFIG = cfg;
              return {
                runApp: async function runApp() {
                  context.__APP_RUNNER_RUN_APP_CALLED = true;
                },
              };
            },
          });
        });
      },
    },
  };

  const manifestByCall = latestManifests.slice();
  const embeddedBootManifest = bootManifest || pinnedManifest || latestManifests[0];
  const pinnedBootManifest = pinnedManifest || (versionPinned ? embeddedBootManifest : null);
  context.fetch = async function fetchMock(url) {
    const urlText = String(url);
    if (urlText.includes('/version/') && urlText.endsWith('/latest.json')) {
      manifestCalls.push(urlText);
      return {
        ok: true,
        json: async () => embeddedBootManifest,
      };
    }

    if (urlText.endsWith('/latest.json')) {
      manifestCalls.push(urlText);
      if (rootLatestFails) {
        return {
          ok: false,
          status: 503,
          json: async () => {
            throw new Error('root latest unavailable');
          },
        };
      }
      const manifest = versionPinned
        ? pinnedBootManifest
        : manifestByCall[Math.min(rootManifestCallCount, manifestByCall.length - 1)];
      rootManifestCallCount += 1;
      return {
        ok: true,
        json: async () => manifest,
      };
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const source = fs.readFileSync(
    appUpdateTemplatePath,
    'utf8',
  );

  vm.createContext(context);
  const seededLastGoodManifest = savedManifest || initialLastGoodManifest;
  if (seededLastGoodManifest || nextManifest) {
    const seedScript = [
      seededLastGoodManifest
        ? `localStorage.setItem('flutter.lastGoodManifest', ${JSON.stringify(JSON.stringify(seededLastGoodManifest))});`
        : '',
      nextManifest
        ? `localStorage.setItem('flutter.nextManifest', ${JSON.stringify(JSON.stringify(nextManifest))});`
        : '',
    ].join('\n');
    vm.runInContext(seedScript, context, { filename: 'app_update_boot.test.seed.js' });
  }
  vm.runInContext(source, context, { filename: 'app_update.js' });

  return {
    context,
    downloadCalls,
    manifestCalls,
    cleanupCalls,
    reloadCalls,
    blobStore,
  };
}

test('app_update boots through gz bootstrap blob until flutter init', async () => {
  const harness = makeHarness({
    latestManifests: [makeManifest('202605141110', '')],
  });

  await waitFor(() => harness.context.__RUN_APP_DONE === true);

  assert.equal(harness.context.__LOADER_LOAD_CALLED, true);
  assert.equal(harness.context.__ON_ENTRYPOINT_LOADED, true);
  assert.equal(harness.context.__INITIALIZE_ENGINE_DONE, true);
  assert.equal(harness.context.__APP_RUNNER_RUN_APP_CALLED, true);
  assert.equal(harness.context.__RUN_APP_DONE, true);
  assert.equal(harness.context.__FLUTTER_BUILD__, '202605141110');
  assert.equal(harness.downloadCalls[0].endsWith('/version/202605141110/flutter_bootstrap.js.gz'), true);
});

test('app_update boots embedded version when root latest.json is unavailable', async () => {
  const embeddedManifest = makeManifest('202605141110', '');
  const harness = makeHarness({
    latestManifests: [makeManifest('202605141111', 'new/')],
    bootManifest: embeddedManifest,
    rootLatestFails: true,
  });

  await waitFor(() => harness.context.__RUN_APP_DONE === true);

  assert.equal(
    harness.manifestCalls.some(url => url.endsWith('/version/202605141110/latest.json')),
    true,
  );
  assert.equal(
    harness.downloadCalls[0].endsWith('/version/202605141110/flutter_bootstrap.js.gz'),
    true,
  );
  assert.equal(harness.context.__FLUTTER_BUILD__, '202605141110');
});

test('app_update keeps lastGoodManifest as default while nextManifest is incomplete', async () => {
  const lastGoodManifest = makeManifest('202605141109', 'old/');
  const nextManifest = makeManifest('202605141110', 'next/');
  const latestManifest = makeManifest('202605141110', '');
  const bootCacheState = new Map([
    [
      `${lastGoodManifest.base}old/flutter_bootstrap.js.gz`,
      { complete: true, bytes: new Uint8Array([1, 2, 3, 4]), totalBytes: 4, resourceLength: 4 },
    ],
    [
      `${nextManifest.base}next/flutter_bootstrap.js.gz`,
      { complete: false, bytes: new Uint8Array([1, 2]), totalBytes: 2, resourceLength: 4 },
    ],
  ]);
  const harness = makeHarness({
    latestManifests: [latestManifest],
    initialLastGoodManifest: lastGoodManifest,
    nextManifest,
    bootCacheState,
  });

  assert.equal(
    harness.context.localStorage.getItem('flutter.lastGoodManifest'),
    JSON.stringify(lastGoodManifest),
  );

  await waitFor(() => harness.context.__RUN_APP_DONE === true);

  assert.equal(
    harness.downloadCalls[0].endsWith('/version/202605141109/old/flutter_bootstrap.js.gz'),
    true,
  );
  assert.equal(
    harness.context.localStorage.getItem('flutter.lastGoodManifest'),
    JSON.stringify(lastGoodManifest),
  );
  assert.equal(
    harness.context.localStorage.getItem('flutter.nextManifest'),
    JSON.stringify(nextManifest),
  );
});

test('app_update promotes a ready next manifest when it matches latest.json', async () => {
  const nextManifest = makeManifest('202605141111', 'next/');
  const bootCacheState = new Map([
    [
      `${nextManifest.base}next/flutter_bootstrap.js.gz`,
      { complete: true, bytes: new Uint8Array([1, 2, 3, 4]), totalBytes: 4, resourceLength: 4 },
    ],
  ]);
  const harness = makeHarness({
    latestManifests: [nextManifest],
    nextManifest,
    bootCacheState,
  });

  await waitFor(() => harness.context.__RUN_APP_DONE === true);

  assert.equal(
    harness.downloadCalls[0].endsWith('/version/202605141111/next/flutter_bootstrap.js.gz'),
    true,
  );
  assert.equal(
    harness.context.localStorage.getItem('flutter.lastGoodManifest'),
    JSON.stringify(nextManifest),
  );
  assert.equal(
    harness.context.localStorage.getItem('flutter.nextManifest'),
    null,
  );
});

test('app_update hard update discards lastGoodManifest and boots latest', async () => {
  const lastGoodManifest = makeManifest('202605141109', 'old/');
  const nextManifest = makeManifest('202605141110', 'next/');
  const latestManifest = {
    ...makeManifest('202605141112', ''),
    hardUpdate: true,
  };
  const harness = makeHarness({
    latestManifests: [latestManifest],
    initialLastGoodManifest: lastGoodManifest,
    nextManifest,
  });

  await waitFor(() => harness.context.__RUN_APP_DONE === true);

  assert.equal(harness.context.localStorage.getItem('flutter.nextManifest'), null);
  assert.equal(
    harness.downloadCalls[0].endsWith('/version/202605141112/flutter_bootstrap.js.gz'),
    true,
  );
  assert.equal(
    harness.downloadCalls.some(url => url.includes('/version/202605141109/old/')),
    false,
  );
  assert.equal(
    JSON.parse(harness.context.localStorage.getItem('flutter.lastGoodManifest')).version,
    '202605141112',
  );
  assert.equal(
    harness.cleanupCalls.some(call => call.startsWith('delete:') && call.includes('202605141109')),
    true,
  );
});

test('app_update dismisses a next manifest when it does not match latest.json', async () => {
  const nextManifest = makeManifest('202605141111', 'next/');
  const latestManifest = makeManifest('202605141112', '');
  const lastGoodManifest = makeManifest('202605141109', 'old/');
  const bootCacheState = new Map([
    [
      `${lastGoodManifest.base}old/flutter_bootstrap.js.gz`,
      { complete: true, bytes: new Uint8Array([1, 2, 3, 4]), totalBytes: 4, resourceLength: 4 },
    ],
    [
      `${nextManifest.base}flutter_bootstrap.js.gz`,
      { complete: true, bytes: new Uint8Array([1, 2, 3, 4]), totalBytes: 4, resourceLength: 4 },
    ],
  ]);
  const harness = makeHarness({
    latestManifests: [latestManifest],
    initialLastGoodManifest: lastGoodManifest,
    nextManifest,
    bootCacheState,
  });

  assert.equal(
    harness.context.localStorage.getItem('flutter.lastGoodManifest'),
    JSON.stringify(lastGoodManifest),
  );

  await waitFor(() => harness.context.__RUN_APP_DONE === true);

  assert.equal(
    harness.downloadCalls[0].endsWith('/version/202605141109/old/flutter_bootstrap.js.gz'),
    true,
  );
  assert.equal(
    harness.context.localStorage.getItem('flutter.lastGoodManifest'),
    JSON.stringify(lastGoodManifest),
  );
  assert.equal(
    harness.context.localStorage.getItem('flutter.nextManifest'),
    null,
  );
});

test('app_update hard update reloads an already running session instead of sideloading', async () => {
  const runningManifest = makeManifest('202605141110', '');
  const latestManifest = {
    ...makeManifest('202605141111', 'next/'),
    hardUpdate: true,
  };
  const harness = makeHarness({
    latestManifests: [runningManifest, latestManifest],
    initialLastGoodManifest: runningManifest,
    runBackgroundTimers: true,
  });

  await waitFor(() => harness.context.__RUN_APP_DONE === true);
  await waitFor(() => harness.reloadCalls.length === 1);

  assert.equal(harness.context.localStorage.getItem('flutter.lastGoodManifest'), null);
  assert.equal(harness.context.localStorage.getItem('flutter.nextManifest'), null);
  assert.equal(
    harness.downloadCalls.some(url => url.includes('/version/202605141111/')),
    false,
  );
});

test('app_update version-pinned boot uses local latest.json and ignores lastGoodManifest', async () => {
  const pinnedManifest = makeManifest('202605141110', '');
  const lastGoodManifest = makeManifest('202605141108', 'older/');
  const nextManifest = makeManifest('202605141111', 'next/');
  const harness = makeHarness({
    latestManifests: [pinnedManifest],
    pinnedManifest,
    versionPinned: true,
    initialLastGoodManifest: lastGoodManifest,
    nextManifest,
    runBackgroundTimers: true,
  });

  await waitFor(() => harness.context.__RUN_APP_DONE === true);

  assert.equal(
    harness.manifestCalls[0].endsWith('/version/202605141110/latest.json'),
    true,
  );
  assert.equal(
    harness.downloadCalls[0].endsWith('/version/202605141110/flutter_bootstrap.js.gz'),
    true,
  );
  assert.equal(
    harness.context.localStorage.getItem('flutter.lastGoodManifest'),
    JSON.stringify(lastGoodManifest),
  );
  assert.equal(
    harness.context.localStorage.getItem('flutter.nextManifest'),
    JSON.stringify(nextManifest),
  );
  assert.equal(
    harness.manifestCalls.some(url => url === 'https://example.test/latest.json' || url === '/latest.json'),
    false,
  );
  assert.deepEqual(harness.cleanupCalls, []);
  assert.equal(harness.reloadCalls.length, 0);
});

test('app_update starts sideload and downloads versioned gz files after first frame', async () => {
  const harness = makeHarness({
    latestManifests: [
      makeManifest('202605141110', ''),
      makeManifest('202605141111', 'next/'),
    ],
    runBackgroundTimers: true,
  });

  await waitFor(() => harness.downloadCalls.length >= 2);

  assert.equal(harness.context.__RUN_APP_DONE, true);
  assert.equal(harness.downloadCalls[0].endsWith('/version/202605141110/flutter_bootstrap.js.gz'), true);
  assert.equal(
    harness.downloadCalls.some(url => url.endsWith('/version/202605141111/next/flutter_bootstrap.js.gz')),
    true,
  );
  assert.equal(
    harness.downloadCalls.some(url => url.endsWith('/version/202605141111/next/app_update.js.gz')),
    false,
  );
  assert.deepEqual(
    harness.cleanupCalls,
    ['/version/202605141111/flutter_bootstrap.js.gz'],
  );
});
