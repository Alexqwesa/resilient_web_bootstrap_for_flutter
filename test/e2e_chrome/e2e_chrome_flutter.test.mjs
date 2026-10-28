import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { startMutableStaticServer } from './static_server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const sitesRoot = path.join(__dirname, 'sites_flutter');

function hasFlutter() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['flutter'], {
    shell: true,
    encoding: 'utf8',
  });
  return probe.status === 0 && String(probe.stdout || '').trim().length > 0;
}

// Ask the SDK itself: the flag only exists on SDKs with native content hashing.
function supportsWebContentHash() {
  const probe = spawnSync('flutter', ['build', 'web', '-h'], {shell: true, encoding: 'utf8'});
  return probe.status === 0 && String(probe.stdout || '').includes('web-content-hash');
}

// E2E_WEB_CONTENT_HASH: '0' forces legacy, '1' forces hashing, unset follows SDK support.
function resolveContentHash() {
  const env = process.env.E2E_WEB_CONTENT_HASH;
  if (env === '0') return {hashed: false, reason: 'disabled by E2E_WEB_CONTENT_HASH=0'};
  if (env === '1' || supportsWebContentHash()) return {hashed: true};
  return {hashed: false, reason: 'Flutter SDK lacks --web-content-hash (needs 3.50+); ran legacy build'};
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: {...process.env, ...options.env},
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed (${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

async function prepareSites(t, contentHash) {
  await run(
    'dart',
    ['run', 'test/e2e_chrome/prepare_sites_flutter.dart', sitesRoot],
    { cwd: repoRoot, env: {E2E_WEB_CONTENT_HASH: contentHash.hashed ? '1' : '0'} },
  );
  assert.ok(fs.existsSync(path.join(sitesRoot, 'before_apply', 'latest.json')));
  assert.ok(fs.existsSync(path.join(sitesRoot, 'after_apply', 'latest.json')));
  await t.test('real builds share native content-hashed assets', {skip: contentHash.reason ?? false}, () => {
    const root = path.join(sitesRoot, 'after_apply');
    const refs = id => JSON.parse(fs.readFileSync(path.join(root, 'version', id, 'asset_refs.json'), 'utf8')).assets;
    const a = refs('before_apply');
    const b = refs('after_apply');
    assert.ok(a.some(asset => b.includes(asset)), 'real builds must share unchanged asset URLs');
    const files = fs.readdirSync(path.join(root, 'assets'), {recursive: true, withFileTypes: true}).filter(entry => entry.isFile());
    assert.equal(files.length, new Set([...a, ...b]).size);
    for (const id of ['before_apply', 'after_apply']) assert.equal(fs.existsSync(path.join(root, 'version', id, 'assets')), false);
  });
}

async function waitForFlutterVersion(page, version, timeoutMs = 120000) {
  await page.waitForFunction(
    (expected) => {
      const attr = document.documentElement.getAttribute('data-e2e-flutter');
      const win = window.__E2E_FLUTTER_VERSION__;
      return attr === expected || win === expected;
    },
    version,
    { timeout: timeoutMs },
  );
}

const flutterAvailable = hasFlutter();

test(
  'chrome e2e (real Flutter): before_apply loads, after_apply hard-update boots new version',
  { skip: flutterAvailable ? false : 'Flutter SDK not found on PATH' },
  async (t) => {
    await prepareSites(t, resolveContentHash());

    const site = { rootDir: path.join(sitesRoot, 'before_apply') };
    const server = await startMutableStaticServer(site);
    t.after(async () => {
      await server.close();
    });

    const headed = process.env.E2E_HEADED === '1' || process.env.E2E_HEADED === 'true';
    const browser = await chromium.launch({
      headless: !headed,
      slowMo: headed ? Number(process.env.E2E_SLOWMO_MS || 250) : 0,
      channel: process.env.E2E_CHROME_CHANNEL || undefined,
    });
    t.after(async () => {
      await browser.close();
    });

    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    const failedAssets = [];
    page.on('response', response => {
      if (response.status() >= 400 && /\/assets\//.test(response.url())) failedAssets.push(response.url());
    });
    await page.goto(`${server.origin}/index.html`, {
      waitUntil: 'domcontentloaded',
    });
    try {
      await waitForFlutterVersion(page, 'before_apply');
      assert.equal(await page.getAttribute('html', 'data-e2e-assets'), 'ready');
      assert.deepEqual(failedAssets, []);
    } catch (error) {
      const debug = await page.evaluate(() => ({
        title: document.title,
        bodyText: (document.body && document.body.innerText || '').slice(0, 1500),
        attr: document.documentElement.getAttribute('data-e2e-flutter'),
        win: window.__E2E_FLUTTER_VERSION__ || null,
        flutterBuild: window.__FLUTTER_BUILD__ || null,
        preloader: !!document.getElementById('ck-preloader'),
      }));
      console.error('before_apply Flutter boot debug:', debug);
      console.error('console errors:', consoleErrors);
      throw error;
    }

    assert.equal(
      await page.evaluate(() => window.__E2E_FLUTTER_VERSION__),
      'before_apply',
    );
    assert.equal(
      await page.evaluate(() => window.__FLUTTER_BUILD__),
      'before_apply',
    );
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.getAttribute('data-e2e-flutter'),
      ),
      'before_apply',
    );

    site.rootDir = path.join(sitesRoot, 'after_apply');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForFlutterVersion(page, 'after_apply');
    assert.equal(
      await page.evaluate(() => window.__E2E_FLUTTER_VERSION__),
      'after_apply',
    );
    assert.equal(
      await page.evaluate(() => window.__FLUTTER_BUILD__),
      'after_apply',
    );

    const latest = await page.evaluate(async () => {
      const res = await fetch('/latest.json', { cache: 'no-store' });
      return res.json();
    });
    assert.equal(latest.version, 'after_apply');
    assert.equal(latest.hardUpdate, true);

    await page.goto(`${server.origin}/version/before_apply/index.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForFlutterVersion(page, 'before_apply');
    assert.equal(await page.evaluate(() => window.__resilientVersionPinned), true);

    // A returning browser can remember a release that no longer exists.
    const rootManifestPath = path.join(sitesRoot, 'after_apply', 'latest.json');
    const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
    delete rootManifest.hardUpdate;
    fs.writeFileSync(rootManifestPath, JSON.stringify(rootManifest));
    await page.evaluate(manifest => {
      localStorage.setItem('flutter.lastGoodManifest', JSON.stringify({...manifest, version: 'expired', base: '/version/expired/'}));
      localStorage.removeItem('flutter.nextManifest');
    }, rootManifest);
    await page.goto(`${server.origin}/index.html`, {waitUntil: 'domcontentloaded'});
    await waitForFlutterVersion(page, 'after_apply');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('flutter.lastGoodManifest') || '{}').version === 'after_apply');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('flutter.recoveryVersion')), null);
    assert.deepEqual(failedAssets, []);

    const fatal = consoleErrors.filter((line) => {
      const text = String(line);
      return (
        !/favicon/i.test(text) &&
        !/Failed to load resource/i.test(text) &&
        !/net::ERR_/i.test(text)
      );
    });
    assert.deepEqual(fatal, []);
  },
);
