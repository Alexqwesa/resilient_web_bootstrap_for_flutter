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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
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

async function prepareSites() {
  await run(
    'dart',
    ['run', 'test/e2e_chrome/prepare_sites_flutter.dart', sitesRoot],
    { cwd: repoRoot },
  );
  assert.ok(fs.existsSync(path.join(sitesRoot, 'before_apply', 'latest.json')));
  assert.ok(fs.existsSync(path.join(sitesRoot, 'after_apply', 'latest.json')));
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
    await prepareSites();

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

    await page.goto(`${server.origin}/index.html`, {
      waitUntil: 'domcontentloaded',
    });
    try {
      await waitForFlutterVersion(page, 'before_apply');
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
