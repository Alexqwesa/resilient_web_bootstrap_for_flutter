const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');

function loadSha256Fallback() {
  const code = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'sha256_fallback.js'),
    'utf8',
  );
  const context = { globalThis: {} };
  vm.runInNewContext(code, context);
  return context.globalThis.Sha256Fallback;
}

test('sha256_fallback matches node crypto for sample payloads', () => {
  const fallback = loadSha256Fallback();
  const samples = [
    new Uint8Array(0),
    Uint8Array.from([1, 2, 3, 4]),
    new TextEncoder().encode('hello from http deploy'),
    crypto.randomBytes(4096),
  ];

  for (const bytes of samples) {
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    const actual = fallback.sha256Hex(bytes);
    assert.equal(actual, expected);
  }
});
