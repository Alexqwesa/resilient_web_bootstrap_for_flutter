import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const sitesRoot = path.join(__dirname, 'sites');

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
  await run('dart', ['run', 'test/e2e_chrome/prepare_sites.dart', sitesRoot], {
    cwd: repoRoot,
  });
  assert.ok(fs.existsSync(path.join(sitesRoot, 'before_apply', 'latest.json')));
  assert.ok(fs.existsSync(path.join(sitesRoot, 'after_apply', 'latest.json')));
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.gz':
      return 'application/gzip';
    default:
      return 'application/octet-stream';
  }
}

function startMutableStaticServer(site) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') {
      pathname = '/index.html';
    }
    const relative = pathname.replace(/^\/+/, '');
    const rootDir = site.rootDir;
    const filePath = path.normalize(path.join(rootDir, relative));
    const rootWithSep = path.normalize(rootDir + path.sep);
    if (!filePath.startsWith(rootWithSep) && filePath !== path.normalize(rootDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const bytes = fs.readFileSync(filePath);
    const isHtml = relative === 'index.html' || /(?:^|\/)index\.html$/.test(relative);
    const isLatest = relative === 'latest.json' || /(?:^|\/)latest\.json$/.test(relative);
    const headers = {
      'Content-Type': contentTypeFor(filePath),
      'Accept-Ranges': 'bytes',
    };
    if (isHtml || isLatest) {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
    } else if (relative.startsWith('version/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [startText, endText] = range.slice('bytes='.length).split('-');
      const start = Number(startText);
      const end = endText ? Number(endText) : bytes.length - 1;
      const slice = bytes.subarray(start, end + 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
      headers['Content-Length'] = String(slice.length);
      res.writeHead(206, headers);
      res.end(slice);
      return;
    }

    headers['Content-Length'] = String(bytes.length);
    res.writeHead(200, headers);
    res.end(bytes);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        async close() {
          await new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          });
        },
      });
    });
  });
}

async function waitForApp(page, version, timeoutMs = 45000) {
  await page.waitForFunction(
    (expected) => {
      const el = document.getElementById('e2e-app');
      return !!(el && el.getAttribute('data-version') === expected);
    },
    version,
    { timeout: timeoutMs },
  );
}

test('chrome e2e: before_apply loads, after_apply hard-update boots new version', async (t) => {
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
    await waitForApp(page, 'before_apply');
  } catch (error) {
    const debug = await page.evaluate(() => ({
      title: document.title,
      bodyText: (document.body && document.body.innerText || '').slice(0, 1500),
      hasE2e: !!document.getElementById('e2e-app'),
      flutterBuild: window.__FLUTTER_BUILD__ || null,
      e2eVersion: window.__E2E_APP_VERSION__ || null,
      preloader: !!document.getElementById('ck-preloader'),
    }));
    console.error('before_apply boot debug:', debug);
    console.error('console errors:', consoleErrors);
    throw error;
  }
  assert.equal(await page.locator('#e2e-app').getAttribute('data-version'), 'before_apply');
  assert.equal(await page.evaluate(() => window.__E2E_APP_VERSION__), 'before_apply');
  assert.equal(await page.evaluate(() => window.__FLUTTER_BUILD__), 'before_apply');

  // Apply deploy: same origin, promote latest.json + new version tree.
  site.rootDir = path.join(sitesRoot, 'after_apply');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page, 'after_apply');
  assert.equal(await page.locator('#e2e-app').getAttribute('data-version'), 'after_apply');
  assert.equal(await page.evaluate(() => window.__E2E_APP_VERSION__), 'after_apply');
  assert.equal(await page.evaluate(() => window.__FLUTTER_BUILD__), 'after_apply');

  const latest = await page.evaluate(async () => {
    const res = await fetch('/latest.json', { cache: 'no-store' });
    return res.json();
  });
  assert.equal(latest.version, 'after_apply');
  assert.equal(latest.hardUpdate, true);

  // Direct version URL keeps the old build pinned.
  await page.goto(`${server.origin}/version/before_apply/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await waitForApp(page, 'before_apply');
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
});
