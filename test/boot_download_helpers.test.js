const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function sha256Hex(bytes) {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest('hex');
}

function makeResponse({ status, bytes, headers }) {
  return {
    status: status,
    data: bytes,
    headers: headers || {},
  };
}

function makeBytes(values) {
  return new Uint8Array(values);
}

function installAxiosMock(responder) {
  const originalAxios = global.axios;
  const calls = [];

  global.axios = {
    request: async function request(config) {
      calls.push({
        url: config.url,
        method: config.method,
        responseType: config.responseType,
        headers: Object.assign({}, config.headers || {}),
        withCredentials: config.withCredentials,
        signal: config.signal,
      });
      return await responder(config, calls.length);
    },
  };

  return {
    calls,
    restore() {
      global.axios = originalAxios;
    },
  };
}

async function loadHelpers() {
  delete require.cache[require.resolve('./boot_download_helpers.js')];
  return require('./boot_download_helpers.js');
}

test('downloadResumableBytes resumes with Range after an early EOF', async () => {
  const axiosMock = installAxiosMock(async function responder(_, callIndex) {
    if (callIndex === 1) {
      return makeResponse({
        status: 206,
        bytes: makeBytes([1, 2, 3, 4]),
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes 0-3/6',
        },
      });
    }

    if (callIndex === 2) {
      return makeResponse({
        status: 206,
        bytes: makeBytes([5, 6]),
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes 4-5/6',
        },
      });
    }

    throw new Error('Unexpected axios call');
  });

  try {
    const helpers = await loadHelpers();

    const result = await helpers.downloadResumableBytes(
      'https://example.test/canvaskit.wasm.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'CanvasKit',
        collectBytes: true,
        totalBytesHint: 6,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(axiosMock.calls.length, 2);
    assert.equal(axiosMock.calls[0].headers.Range, undefined);
    assert.equal(axiosMock.calls[0].headers['Cache-Control'], undefined);
    assert.equal(axiosMock.calls[1].headers.Range, 'bytes=4-');
    assert.equal(axiosMock.calls[1].headers['Cache-Control'], 'no-cache');
    assert.equal(axiosMock.calls[1].headers.Pragma, 'no-cache');
    assert.equal(result.totalBytes, 6);
    assert.equal(result.resourceLength, 6);
    assert.equal(result.bytes.length, 6);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4, 5, 6]);
  } finally {
    axiosMock.restore();
  }
});

test('downloadResumableBytes carries partial progress forward after a transient failure', async () => {
  const originalWindow = global.window;
  const requestCalls = [];

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeStreamingResponse(status, chunkBytesList, headers) {
    let chunkIndex = 0;
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        getReader() {
          return {
            async read() {
              if (chunkIndex < chunkBytesList.length) {
                const value = chunkBytesList[chunkIndex];
                chunkIndex += 1;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
      async arrayBuffer() {
        const merged = [];
        for (const chunk of chunkBytesList) {
          merged.push(...chunk);
        }
        return Uint8Array.from(merged).buffer;
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        if (requestCalls.length === 1) {
          const response = makeStreamingResponse(
            206,
            [Uint8Array.from([1, 2, 3, 4])],
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': 'bytes 0-3/6',
            },
          );

          const reader = response.body.getReader();
          const originalRead = reader.read.bind(reader);
          let firstRead = true;
          response.body.getReader = function getReader() {
            return {
              async read() {
                if (firstRead) {
                  firstRead = false;
                  return await originalRead();
                }
                throw new TypeError('Network failed');
              },
            };
          };
          return response;
        }

        if (requestCalls.length === 2) {
          return makeStreamingResponse(
            206,
            [Uint8Array.from([5, 6])],
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': 'bytes 4-5/6',
            },
          );
        }

        throw new Error('Unexpected fetch call');
      },
    };

    const helpers = await loadHelpers();

    const result = await helpers.downloadResumableBytes(
      'https://example.test/canvaskit.wasm.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'CanvasKit',
        collectBytes: true,
        totalBytesHint: 6,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 2);
    assert.equal(requestCalls[0].headers.Range, undefined);
    assert.equal(requestCalls[1].headers.Range, 'bytes=4-');
    assert.equal(result.totalBytes, 6);
    assert.equal(result.resourceLength, 6);
    assert.equal(result.bytes.length, 6);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4, 5, 6]);
  } finally {
    global.window = originalWindow;
  }
});

test('downloadResumableBytes does not double-count bytes when a fetch response ends early', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const requestCalls = [];
  const cacheStore = new Map();

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeStreamingResponse(status, chunkBytesList, headers) {
    let chunkIndex = 0;
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        getReader() {
          return {
            async read() {
              if (chunkIndex < chunkBytesList.length) {
                const value = chunkBytesList[chunkIndex];
                chunkIndex += 1;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
      async arrayBuffer() {
        const merged = [];
        for (const chunk of chunkBytesList) {
          merged.push(...chunk);
        }
        return Uint8Array.from(merged).buffer;
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        if (requestCalls.length === 1) {
          return makeStreamingResponse(
            206,
            [Uint8Array.from([1, 2, 3, 4])],
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': 'bytes 0-3/6',
            },
          );
        }

        if (requestCalls.length === 2) {
          return makeStreamingResponse(
            206,
            [Uint8Array.from([5, 6])],
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': 'bytes 4-5/6',
            },
          );
        }

        throw new Error('Unexpected fetch call');
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/canvaskit.wasm.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'CanvasKit',
        collectBytes: true,
        totalBytesHint: 6,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 2);
    assert.equal(requestCalls[0].headers.Range, undefined);
    assert.equal(requestCalls[1].headers.Range, 'bytes=4-');
    assert.equal(result.totalBytes, 6);
    assert.equal(result.resourceLength, 6);
    assert.equal(result.bytes.length, 6);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4, 5, 6]);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes resumes sideload-style downloads through fetch without collecting bytes', async () => {
  const originalWindow = global.window;
  const requestCalls = [];

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeStreamingResponse(status, chunkBytesList, headers) {
    let chunkIndex = 0;
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        getReader() {
          return {
            async read() {
              if (chunkIndex < chunkBytesList.length) {
                const value = chunkBytesList[chunkIndex];
                chunkIndex += 1;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
      async arrayBuffer() {
        const merged = [];
        for (const chunk of chunkBytesList) {
          merged.push(...chunk);
        }
        return Uint8Array.from(merged).buffer;
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        if (requestCalls.length === 1) {
          const response = makeStreamingResponse(
            206,
            [Uint8Array.from([1, 2, 3, 4])],
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': 'bytes 0-3/6',
            },
          );

          const reader = response.body.getReader();
          const originalRead = reader.read.bind(reader);
          let firstRead = true;
          response.body.getReader = function getReader() {
            return {
              async read() {
                if (firstRead) {
                  firstRead = false;
                  return await originalRead();
                }
                throw new TypeError('Network failed');
              },
            };
          };
          return response;
        }

        if (requestCalls.length === 2) {
          return makeStreamingResponse(
            206,
            [Uint8Array.from([5, 6])],
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': 'bytes 4-5/6',
            },
          );
        }

        throw new Error('Unexpected fetch call');
      },
    };

    const helpers = await loadHelpers();

    const result = await helpers.downloadResumableBytes(
      'https://example.test/assets/app_update.js.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'app_update.js.gz',
        collectBytes: false,
        totalBytesHint: 6,
        cacheBytesLimit: 1,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 2);
    assert.equal(requestCalls[0].headers.Range, undefined);
    assert.equal(requestCalls[1].headers.Range, 'bytes=4-');
    assert.equal(result.totalBytes, 6);
    assert.equal(result.resourceLength, 6);
    assert.equal(result.bytes, null);
  } finally {
    global.window = originalWindow;
  }
});

test('downloadResumableBytes reuses completed downloads from persistent cache after module reload', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const requestCalls = [];
  const cacheStore = new Map();

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeResponse(status, bytes, headers) {
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) {
                return { done: true, value: undefined };
              }
              done = true;
              return { done: false, value: bytes };
            },
          };
        },
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        return makeResponse(
          200,
          Uint8Array.from([1, 2, 3, 4]),
          {
            'Content-Type': 'application/octet-stream',
          },
        );
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    let helpers = await loadHelpers();
    const first = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'AssetManifest',
        collectBytes: false,
        totalBytesHint: 4,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    delete require.cache[require.resolve('./boot_download_helpers.js')];
    helpers = await loadHelpers();
    const second = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'AssetManifest',
        collectBytes: true,
        totalBytesHint: 4,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 1);
    assert.equal(first.totalBytes, 4);
    assert.equal(second.totalBytes, 4);
    assert.equal(second.bytes.length, 4);
    assert.deepEqual(Array.from(second.bytes), [1, 2, 3, 4]);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes reuses a ready cache entry when SHA-256 matches', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const cacheStore = new Map();
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const expectedSha256 = sha256Hex(bytes);
  let fetchCount = 0;

  try {
    cacheStore.set('boot-downloads-v1', new Map([
      ['https://example.test/assets/AssetManifest.bin.gz', new Response(bytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Boot-Complete': '1',
          'X-Boot-Total-Bytes': '4',
          'X-Boot-Resource-Length': '4',
          'X-Boot-Sha256': expectedSha256,
        },
      })],
    ]));

    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock() {
        fetchCount += 1;
        throw new Error('Unexpected fetch call');
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: true,
        totalBytesHint: 4,
        expectedSha256,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(fetchCount, 0);
    assert.equal(result.sha256, expectedSha256);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes detects bad ready cache hash and redownloads the file', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const cacheStore = new Map();
  const goodBytes = Uint8Array.from([1, 2, 3, 4]);
  const badBytes = Uint8Array.from([9, 9, 9, 9]);
  const expectedSha256 = sha256Hex(goodBytes);
  const requestCalls = [];

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  try {
    cacheStore.set('boot-downloads-v1', new Map([
      ['https://example.test/assets/AssetManifest.bin.gz', new Response(badBytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Boot-Complete': '1',
          'X-Boot-Total-Bytes': '4',
          'X-Boot-Resource-Length': '4',
        },
      })],
    ]));

    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        return {
          status: 200,
          headers: makeHeaders({
            'Content-Type': 'application/octet-stream',
          }),
          body: {
            getReader() {
              let done = false;
              return {
                async read() {
                  if (done) {
                    return { done: true, value: undefined };
                  }
                  done = true;
                  return { done: false, value: goodBytes };
                },
              };
            },
          },
          async arrayBuffer() {
            return goodBytes.buffer.slice(goodBytes.byteOffset, goodBytes.byteOffset + goodBytes.byteLength);
          },
        };
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: true,
        totalBytesHint: 4,
        expectedSha256,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    const readyCache = cacheStore.get('boot-downloads-v1').get('https://example.test/assets/AssetManifest.bin.gz');

    assert.equal(requestCalls.length, 1);
    assert.equal(result.sha256, expectedSha256);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
    assert.equal(readyCache.headers.get('X-Boot-Sha256'), expectedSha256);
    assert.deepEqual(Array.from(new Uint8Array(await readyCache.arrayBuffer())), [1, 2, 3, 4]);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes rejects a fresh download when SHA-256 mismatches', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const cacheStore = new Map();
  const expectedSha256 = sha256Hex(Uint8Array.from([1, 2, 3, 4]));
  const badBytes = Uint8Array.from([4, 3, 2, 1]);

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock() {
        return {
          status: 200,
          headers: makeHeaders({
            'Content-Type': 'application/octet-stream',
          }),
          body: {
            getReader() {
              let done = false;
              return {
                async read() {
                  if (done) {
                    return { done: true, value: undefined };
                  }
                  done = true;
                  return { done: false, value: badBytes };
                },
              };
            },
          },
          async arrayBuffer() {
            return badBytes.buffer.slice(badBytes.byteOffset, badBytes.byteOffset + badBytes.byteLength);
          },
        };
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    await assert.rejects(
      helpers.downloadResumableBytes(
        'https://example.test/assets/AssetManifest.bin.gz',
        { cache: 'force-cache' },
        {
          label: 'AssetManifest',
          collectBytes: true,
          totalBytesHint: 4,
          expectedSha256,
          idleMs: 1000,
          maxAttempts: 5,
          retryDelayMs: 0,
          maxRetryDelayMs: 0,
        },
      ),
      /SHA-256 mismatch/,
    );

    const bucket = cacheStore.get('boot-downloads-v1');
    assert.equal(bucket.has('https://example.test/assets/AssetManifest.bin.gz'), false);
    assert.equal(bucket.has('https://example.test/assets/AssetManifest.bin.gz?_bootPartial=1'), false);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes detects bad partial cache hash and restarts from byte zero', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const cacheStore = new Map();
  const goodBytes = Uint8Array.from([1, 2, 3, 4]);
  const badPartial = Uint8Array.from([9, 9]);
  const expectedSha256 = sha256Hex(goodBytes);
  const requestCalls = [];

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeStreamingResponse(status, bytes, headers) {
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) {
                return { done: true, value: undefined };
              }
              done = true;
              return { done: false, value: bytes };
            },
          };
        },
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  try {
    cacheStore.set('boot-downloads-v1', new Map([
      ['https://example.test/assets/AssetManifest.bin.gz?_bootPartial=1', new Response(badPartial, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Boot-Complete': '0',
          'X-Boot-Total-Bytes': '2',
          'X-Boot-Resource-Length': '4',
        },
      })],
    ]));

    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        if (requestCalls.length === 1) {
          return makeStreamingResponse(206, Uint8Array.from([3, 4]), {
            'Content-Type': 'application/octet-stream',
            'Content-Range': 'bytes 2-3/4',
          });
        }

        if (requestCalls.length === 2) {
          return makeStreamingResponse(200, goodBytes, {
            'Content-Type': 'application/octet-stream',
          });
        }

        throw new Error('Unexpected fetch call');
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: true,
        totalBytesHint: 4,
        expectedSha256,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 2);
    assert.equal(requestCalls[0].headers.Range, 'bytes=2-');
    assert.equal(requestCalls[1].headers.Range, undefined);
    assert.equal(result.sha256, expectedSha256);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
    assert.equal(cacheStore.get('boot-downloads-v1').has('https://example.test/assets/AssetManifest.bin.gz?_bootPartial=1'), false);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes ignores UI-only resume offset when SHA-256 validation is required', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const cacheStore = new Map();
  const fullBytes = Uint8Array.from([1, 2, 3, 4]);
  const expectedSha256 = sha256Hex(fullBytes);
  const requestCalls = [];

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        return {
          status: 200,
          headers: makeHeaders({
            'Content-Type': 'application/octet-stream',
          }),
          body: {
            getReader() {
              let done = false;
              return {
                async read() {
                  if (done) {
                    return { done: true, value: undefined };
                  }
                  done = true;
                  return { done: false, value: fullBytes };
                },
              };
            },
          },
          async arrayBuffer() {
            return fullBytes.buffer.slice(fullBytes.byteOffset, fullBytes.byteOffset + fullBytes.byteLength);
          },
        };
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: false,
        totalBytesHint: 4,
        initialBytesLoaded: 2,
        expectedSha256,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 1);
    assert.equal(requestCalls[0].headers.Range, undefined);
    assert.equal(result.totalBytes, 4);
    assert.equal(result.sha256, expectedSha256);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes rejects mismatched Content-Range during hash-checked resume', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const cacheStore = new Map();
  const partialBytes = Uint8Array.from([1, 2]);
  const fullBytes = Uint8Array.from([1, 2, 3, 4]);
  const expectedSha256 = sha256Hex(fullBytes);
  const requestCalls = [];

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeStreamingResponse(status, bytes, headers) {
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) {
                return { done: true, value: undefined };
              }
              done = true;
              return { done: false, value: bytes };
            },
          };
        },
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  try {
    cacheStore.set('boot-downloads-v1', new Map([
      ['https://example.test/assets/AssetManifest.bin.gz?_bootPartial=1', new Response(partialBytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Boot-Complete': '0',
          'X-Boot-Total-Bytes': '2',
          'X-Boot-Resource-Length': '4',
        },
      })],
    ]));

    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        if (requestCalls.length === 1) {
          return makeStreamingResponse(206, Uint8Array.from([2, 3, 4]), {
            'Content-Type': 'application/octet-stream',
            'Content-Range': 'bytes 1-3/4',
          });
        }

        if (requestCalls.length === 2) {
          return makeStreamingResponse(206, Uint8Array.from([3, 4]), {
            'Content-Type': 'application/octet-stream',
            'Content-Range': 'bytes 2-3/4',
          });
        }

        throw new Error('Unexpected fetch call');
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: false,
        totalBytesHint: 4,
        expectedSha256,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 2);
    assert.equal(requestCalls[0].headers.Range, 'bytes=2-');
    assert.equal(requestCalls[1].headers.Range, 'bytes=2-');
    assert.equal(result.totalBytes, 4);
    assert.equal(result.sha256, expectedSha256);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes cancels ignored Range 200 response and retries same offset', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const cacheStore = new Map();
  const partialBytes = Uint8Array.from([1, 2]);
  const fullBytes = Uint8Array.from([1, 2, 3, 4]);
  const expectedSha256 = sha256Hex(fullBytes);
  const requestCalls = [];
  let ignoredRangeBodyCanceled = false;

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeStreamingResponse(status, bytes, headers, options = {}) {
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        async cancel() {
          if (options.markCanceled) {
            ignoredRangeBodyCanceled = true;
          }
        },
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) {
                return { done: true, value: undefined };
              }
              done = true;
              return { done: false, value: bytes };
            },
          };
        },
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  try {
    cacheStore.set('boot-downloads-v1', new Map([
      ['https://example.test/assets/AssetManifest.bin.gz?_bootPartial=1', new Response(partialBytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Boot-Complete': '0',
          'X-Boot-Total-Bytes': '2',
          'X-Boot-Resource-Length': '4',
        },
      })],
    ]));

    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        if (requestCalls.length === 1) {
          return makeStreamingResponse(200, fullBytes, {
            'Content-Type': 'application/octet-stream',
          }, { markCanceled: true });
        }

        if (requestCalls.length === 2) {
          return makeStreamingResponse(206, Uint8Array.from([3, 4]), {
            'Content-Type': 'application/octet-stream',
            'Content-Range': 'bytes 2-3/4',
          });
        }

        throw new Error('Unexpected fetch call');
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: false,
        totalBytesHint: 4,
        expectedSha256,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 2);
    assert.equal(requestCalls[0].headers.Range, 'bytes=2-');
    assert.equal(requestCalls[1].headers.Range, 'bytes=2-');
    assert.equal(ignoredRangeBodyCanceled, true);
    assert.equal(result.totalBytes, 4);
    assert.equal(result.sha256, expectedSha256);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes can accept ignored Range 200 as full restart when strict resume is disabled', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const cacheStore = new Map();
  const partialBytes = Uint8Array.from([1, 2]);
  const fullBytes = Uint8Array.from([1, 2, 3, 4]);
  const expectedSha256 = sha256Hex(fullBytes);
  const requestCalls = [];

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeStreamingResponse(status, bytes, headers) {
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) {
                return { done: true, value: undefined };
              }
              done = true;
              return { done: false, value: bytes };
            },
          };
        },
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  try {
    cacheStore.set('boot-downloads-v1', new Map([
      ['https://example.test/assets/AssetManifest.bin.gz?_bootPartial=1', new Response(partialBytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Boot-Complete': '0',
          'X-Boot-Total-Bytes': '2',
          'X-Boot-Resource-Length': '4',
        },
      })],
    ]));

    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        if (requestCalls.length === 1) {
          return makeStreamingResponse(200, fullBytes, {
            'Content-Type': 'application/octet-stream',
          });
        }

        throw new Error('Unexpected fetch call');
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: true,
        totalBytesHint: 4,
        expectedSha256,
        strictRangeResume: false,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 1);
    assert.equal(requestCalls[0].headers.Range, 'bytes=2-');
    assert.equal(result.totalBytes, 4);
    assert.equal(result.sha256, expectedSha256);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes retries the same resume offset when a resumed axios request returns 200', async () => {
  const axiosMock = installAxiosMock(async function responder(_, callIndex) {
    if (callIndex === 1) {
      return makeResponse({
        status: 206,
        bytes: makeBytes([1, 2, 3, 4]),
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes 0-3/6',
        },
      });
    }

    if (callIndex === 2) {
      return makeResponse({
        status: 200,
        bytes: makeBytes([1, 2, 3, 4, 5, 6]),
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      });
    }

    if (callIndex === 3) {
      return makeResponse({
        status: 206,
        bytes: makeBytes([5, 6]),
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes 4-5/6',
        },
      });
    }

    throw new Error('Unexpected axios call');
  });

  try {
    const helpers = await loadHelpers();

    const result = await helpers.downloadResumableBytes(
      'https://example.test/canvaskit.wasm.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'CanvasKit',
        collectBytes: true,
        totalBytesHint: 6,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(axiosMock.calls.length, 3);
    assert.equal(axiosMock.calls[0].headers.Range, undefined);
    assert.equal(axiosMock.calls[1].headers.Range, 'bytes=4-');
    assert.equal(axiosMock.calls[2].headers.Range, 'bytes=4-');
    assert.equal(result.totalBytes, 6);
    assert.equal(result.resourceLength, 6);
    assert.equal(result.bytes.length, 6);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4, 5, 6]);
  } finally {
    axiosMock.restore();
  }
});

test('downloadResumableBytes can start a fresh call from a saved byte offset', async () => {
  const axiosMock = installAxiosMock(async function responder(_, callIndex) {
    if (callIndex !== 1) {
      throw new Error('Unexpected second axios call');
    }

    return makeResponse({
      status: 206,
      bytes: Uint8Array.from([5, 6]),
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': 'bytes 4-5/6',
      },
    });
  });

  try {
    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/canvaskit.wasm.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'CanvasKit',
        collectBytes: false,
        totalBytesHint: 6,
        initialBytesLoaded: 4,
        idleMs: 50,
        maxAttempts: 2,
        retryDelayMs: 1,
        maxRetryDelayMs: 1,
      },
    );

    assert.equal(axiosMock.calls.length, 1);
    assert.equal(axiosMock.calls[0].headers.Range, 'bytes=4-');
    assert.equal(axiosMock.calls[0].headers['Cache-Control'], 'no-cache');
    assert.equal(axiosMock.calls[0].url.includes('_bootRetry='), true);
    assert.equal(result.totalBytes, 6);
    assert.equal(result.resourceLength, 6);
  } finally {
    axiosMock.restore();
  }
});

test('downloadResumableBytes reuses completed boot downloads in-session even when the first pass did not collect bytes', async () => {
  let fetchCount = 0;
  const axiosMock = installAxiosMock(async function responder() {
    fetchCount += 1;
    if (fetchCount > 1) {
      throw new Error('Unexpected second axios call');
    }

    return makeResponse({
      status: 200,
      bytes: makeBytes([1, 2, 3, 4]),
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  });

  try {
    const helpers = await loadHelpers();

    const first = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'AssetManifest',
        collectBytes: false,
        totalBytesHint: 4,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    const second = await helpers.downloadResumableBytes(
      'https://example.test/assets/AssetManifest.bin.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'AssetManifest',
        collectBytes: true,
        totalBytesHint: 4,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(fetchCount, 1);
    assert.equal(first.totalBytes, 4);
    assert.equal(second.totalBytes, 4);
    assert.equal(second.bytes.length, 4);
    assert.deepEqual(Array.from(second.bytes), [1, 2, 3, 4]);
  } finally {
    axiosMock.restore();
  }
});

test('downloadResumableBytes reuses an inflight boot download instead of starting a second request', async () => {
  let resolveRequest;
  const axiosMock = installAxiosMock(async function responder(_, callIndex) {
    if (callIndex !== 1) {
      throw new Error('Unexpected second axios call');
    }

    return await new Promise(resolve => {
      resolveRequest = resolve;
    });
  });

  try {
    const helpers = await loadHelpers();

    const firstPromise = helpers.downloadResumableBytes(
      'https://example.test/assets/FontManifest.json.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'FontManifest',
        collectBytes: true,
        totalBytesHint: 4,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    const secondPromise = helpers.downloadResumableBytes(
      'https://example.test/assets/FontManifest.json.gz',
      {
        cache: 'force-cache',
      },
      {
        label: 'FontManifest',
        collectBytes: true,
        totalBytesHint: 4,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(axiosMock.calls.length, 1);

    resolveRequest(makeResponse({
      status: 200,
      bytes: makeBytes([1, 2, 3, 4]),
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    }));

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(axiosMock.calls.length, 1);
    assert.equal(first.totalBytes, 4);
    assert.equal(second.totalBytes, 4);
    assert.deepEqual(Array.from(first.bytes), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(second.bytes), [1, 2, 3, 4]);
  } finally {
    axiosMock.restore();
  }
});

test('downloadResumableBytes aborts an active fetch stream immediately when paused', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const requestCalls = [];
  const abortController = new AbortController();
  let readerCanceled = false;
  let cachedResponse = null;
  let readCount = 0;

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        return {
          status: 206,
          headers: {
            get(name) {
              const lower = String(name).toLowerCase();
              if (lower === 'content-type') return 'application/octet-stream';
              if (lower === 'content-range') return 'bytes 0-9/20';
              return null;
            },
          },
          body: {
            getReader() {
              return {
                cancel() {
                  readerCanceled = true;
                  return Promise.resolve();
                },
                async read() {
                  readCount += 1;
                  if (readCount === 1) {
                    return { done: false, value: Uint8Array.from([1, 2, 3, 4]) };
                  }

                  return await new Promise(function (resolve, reject) {
                    const timer = setTimeout(
                      () => resolve({ done: false, value: Uint8Array.from([5, 6, 7, 8]) }),
                      1000,
                    );

                    abortController.signal.addEventListener('abort', () => {
                      clearTimeout(timer);
                      const err = new Error('Aborted');
                      err.name = 'AbortError';
                      reject(err);
                    }, { once: true });
                  });
                },
              };
            },
          },
          async arrayBuffer() {
            return Uint8Array.from([1, 2, 3, 4]).buffer;
          },
        };
      },
    };
    global.caches = {
      async keys() {
        return [];
      },
      async open() {
        return {
          async match() {
            return null;
          },
          async put(requestUrl, response) {
            cachedResponse = response || null;
            return undefined;
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const downloadPromise = helpers.downloadResumableBytes(
      'https://example.test/canvaskit.wasm.gz',
      { cache: 'force-cache' },
      {
        label: 'CanvasKit',
        collectBytes: true,
        totalBytesHint: 20,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
        abortSignal: abortController.signal,
      },
    );

    setTimeout(() => abortController.abort(), 20);

    await assert.rejects(downloadPromise, /Aborted/);
    assert.equal(requestCalls.length, 1);
    assert.equal(readerCanceled, true);
    assert.ok(cachedResponse);
    assert.equal(cachedResponse.headers.get('X-Boot-Complete'), '0');
    assert.equal(cachedResponse.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal((new Uint8Array(await cachedResponse.arrayBuffer())).length, 4);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes resumes a partially cached boot download after module reload', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const requestCalls = [];
  const cacheStore = new Map();
  const abortController = new AbortController();
  let readCount = 0;

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  function makeStreamingResponse(status, chunkBytesList, headers) {
    let chunkIndex = 0;
    return {
      status,
      headers: makeHeaders(headers),
      body: {
        getReader() {
          return {
            cancel() {
              return Promise.resolve();
            },
            async read() {
              if (chunkIndex < chunkBytesList.length) {
                const value = chunkBytesList[chunkIndex];
                chunkIndex += 1;
                return { done: false, value };
              }

              return await new Promise(function (resolve, reject) {
                const timer = setTimeout(() => resolve({ done: true, value: undefined }), 1000);
                abortController.signal.addEventListener('abort', () => {
                  clearTimeout(timer);
                  const err = new Error('Aborted');
                  err.name = 'AbortError';
                  reject(err);
                }, { once: true });
              });
            },
          };
        },
      },
      async arrayBuffer() {
        const merged = [];
        for (const chunk of chunkBytesList) {
          merged.push(...chunk);
        }
        return Uint8Array.from(merged).buffer;
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url, init) {
        requestCalls.push({
          url: String(url),
          headers: Object.assign({}, init && init.headers ? init.headers : {}),
          cache: init && init.cache,
        });

        if (requestCalls.length === 1) {
          const response = makeStreamingResponse(
            206,
            [Uint8Array.from([1, 2, 3, 4])],
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': 'bytes 0-3/6',
              'ETag': '"boot-1"',
            },
          );

          setTimeout(() => abortController.abort(), 20);
          return response;
        }

        if (requestCalls.length === 2) {
          return makeStreamingResponse(
            206,
            [Uint8Array.from([5, 6])],
            {
              'Content-Type': 'application/octet-stream',
              'Content-Range': 'bytes 4-5/6',
              'ETag': '"boot-1"',
            },
          );
        }

        throw new Error('Unexpected fetch call');
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
          async delete(requestUrl) {
            return bucket.delete(String(requestUrl));
          },
        };
      },
    };

    let helpers = await loadHelpers();
    await assert.rejects(async () => {
      await helpers.downloadResumableBytes(
        'https://example.test/canvaskit.wasm.gz',
        { cache: 'force-cache' },
        {
          label: 'CanvasKit',
          collectBytes: true,
          totalBytesHint: 6,
          idleMs: 1000,
          maxAttempts: 5,
          retryDelayMs: 0,
          maxRetryDelayMs: 0,
          abortSignal: abortController.signal,
        },
      );
    }, /Aborted/);

    const rootCache = cacheStore.get('boot-downloads-v1');
    assert.equal(rootCache.has('https://example.test/canvaskit.wasm.gz'), false);
    assert.equal(rootCache.has('https://example.test/canvaskit.wasm.gz?_bootPartial=1'), true);

    delete require.cache[require.resolve('./boot_download_helpers.js')];
    helpers = await loadHelpers();

    const result = await helpers.downloadResumableBytes(
      'https://example.test/canvaskit.wasm.gz',
      { cache: 'force-cache' },
      {
        label: 'CanvasKit',
        collectBytes: true,
        totalBytesHint: 6,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(requestCalls.length, 2);
    assert.equal(requestCalls[1].headers.Range, 'bytes=4-');
    assert.equal(requestCalls[1].headers['If-Range'], undefined);
    assert.equal(result.totalBytes, 6);
    assert.equal(result.bytes.length, 6);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4, 5, 6]);
    assert.equal(rootCache.has('https://example.test/canvaskit.wasm.gz'), true);
    assert.equal(rootCache.has('https://example.test/canvaskit.wasm.gz?_bootPartial=1'), false);
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('downloadResumableBytes keeps older boot caches until explicit cleanup is requested', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const deleteCalls = [];
  const openCalls = [];
  const cacheStore = new Map();
  cacheStore.set('boot-downloads-v1-202605141600', new Map());

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock(url) {
        openCalls.push(String(url));
        return {
          status: 200,
          headers: makeHeaders({
            'Content-Type': 'application/octet-stream',
          }),
          body: {
            getReader() {
              let done = false;
              return {
                cancel() {
                  return Promise.resolve();
                },
                async read() {
                  if (done) {
                    return { done: true, value: undefined };
                  }
                  done = true;
                  return { done: false, value: Uint8Array.from([1, 2, 3, 4]) };
                },
              };
            },
          },
          async arrayBuffer() {
            return Uint8Array.from([1, 2, 3, 4]).buffer;
          },
        };
      },
    };
    global.caches = {
      async keys() {
        return [
          'boot-downloads-v1-202605141600',
          'boot-downloads-v1-202605141654',
        ];
      },
      async delete(name) {
        deleteCalls.push(String(name));
        return true;
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
        };
      },
    };

    const helpers = await loadHelpers();
    const result = await helpers.downloadResumableBytes(
      'https://example.test/version/202605141654/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: true,
        totalBytesHint: 4,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.equal(result.totalBytes, 4);
    assert.equal(openCalls.length, 1);
    assert.deepEqual(deleteCalls, []);
    assert.ok(cacheStore.has('boot-downloads-v1-202605141600'));
    assert.ok(cacheStore.has('boot-downloads-v1-202605141654'));
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});

test('cleanupStaleBootPersistentCacheNamespaces removes older boot caches after a new version is ready', async () => {
  const originalWindow = global.window;
  const originalCaches = global.caches;
  const deleteCalls = [];
  const cacheStore = new Map();
  cacheStore.set('boot-downloads-v1-202605141600', new Map());

  function makeHeaders(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
      get(name) {
        const target = String(name).toLowerCase();
        for (const [key, value] of map.entries()) {
          if (String(key).toLowerCase() === target) {
            return value;
          }
        }
        return null;
      },
    };
  }

  try {
    global.window = {
      location: { href: 'https://example.test/' },
      fetch: async function fetchMock() {
        return {
          status: 200,
          headers: makeHeaders({
            'Content-Type': 'application/octet-stream',
          }),
          body: {
            getReader() {
              let done = false;
              return {
                cancel() {
                  return Promise.resolve();
                },
                async read() {
                  if (done) {
                    return { done: true, value: undefined };
                  }
                  done = true;
                  return { done: false, value: Uint8Array.from([1, 2, 3, 4]) };
                },
              };
            },
          },
          async arrayBuffer() {
            return Uint8Array.from([1, 2, 3, 4]).buffer;
          },
        };
      },
    };
    global.caches = {
      async keys() {
        return Array.from(cacheStore.keys());
      },
      async delete(name) {
        deleteCalls.push(String(name));
        return cacheStore.delete(String(name));
      },
      async open(name) {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map());
        }
        const bucket = cacheStore.get(name);
        return {
          async match(requestUrl) {
            return bucket.get(String(requestUrl)) || null;
          },
          async put(requestUrl, response) {
            bucket.set(String(requestUrl), response);
          },
        };
      },
    };

    const helpers = await loadHelpers();
    await helpers.downloadResumableBytes(
      'https://example.test/version/202605141654/assets/AssetManifest.bin.gz',
      { cache: 'force-cache' },
      {
        label: 'AssetManifest',
        collectBytes: true,
        totalBytesHint: 4,
        idleMs: 1000,
        maxAttempts: 5,
        retryDelayMs: 0,
        maxRetryDelayMs: 0,
      },
    );

    assert.ok(cacheStore.has('boot-downloads-v1-202605141600'));
    assert.ok(cacheStore.has('boot-downloads-v1-202605141654'));
    assert.equal(deleteCalls.length, 0);

    await helpers.cleanupStaleBootPersistentCacheNamespaces(
      'https://example.test/version/202605141654/assets/AssetManifest.bin.gz',
    );

    assert.deepEqual(deleteCalls, ['boot-downloads-v1-202605141600']);
    assert.equal(cacheStore.has('boot-downloads-v1-202605141600'), false);
    assert.ok(cacheStore.has('boot-downloads-v1-202605141654'));
  } finally {
    global.window = originalWindow;
    global.caches = originalCaches;
  }
});
