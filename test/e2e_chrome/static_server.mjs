import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export function contentTypeFor(filePath) {
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

/** @param {{ rootDir: string }} site */
export function startMutableStaticServer(site) {
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
