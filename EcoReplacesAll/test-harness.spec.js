const http = require('http');
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const PORT = 4179;
const ROOT_DIR = path.resolve(__dirname, '..');

let server;

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.ttf') return 'font/ttf';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  return 'application/octet-stream';
}

function startServer() {
  server = http.createServer((req, res) => {
    const requestUrl = (req.url || '/').split('?')[0];
    const safePath = requestUrl.replace(/^\/+/, '');
    const filePath = path.join(ROOT_DIR, safePath || 'EcoReplacesAll/test-harness.html');
    if (!filePath.startsWith(ROOT_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': getContentType(filePath) });
      fs.createReadStream(filePath).pipe(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, resolve);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

test.beforeAll(async () => {
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
});

test('EcoReplacesAll charts render without truncation on load', async ({ page }) => {
  const url = `http://localhost:${PORT}/EcoReplacesAll/test-harness.html`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.click('#runChecks');
  await page.waitForFunction(() => {
    const lines = Array.from(document.querySelectorAll('.result-line'));
    return lines.length >= 2 && lines.some((line) => line.textContent.includes('Cache-busted refresh'));
  }, { timeout: 25000 });

  const results = await page.$$eval('.result-line', (lines) =>
    lines.map((line) => line.textContent || '')
  );
  const failures = results.filter((text) => text.includes('FAIL'));
  expect(failures).toEqual([]);
});
