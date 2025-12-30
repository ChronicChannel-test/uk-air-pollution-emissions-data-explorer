#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  return argv.reduce((acc, arg) => {
    if (!arg.startsWith('--')) return acc;
    const eqIdx = arg.indexOf('=');
    const key = arg.slice(2, eqIdx === -1 ? undefined : eqIdx);
    const raw = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);
    acc[key] = raw === undefined ? 'true' : raw;
    return acc;
  }, {});
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const port = Number(args.port || config.port || 4100);
const harnessBase = args.base || process.env.HARNESS_BASE_URL || `http://localhost:${port}`;
const mode = (args.mode || 'mini').toLowerCase();
const url = args.url || new URL('/app/EcoReplacesAll/mini-chart-debug.html', harnessBase).toString();
const variants = (args.variants || Array(8).fill('native-overlay').join(','))
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);
const selector = args.selector || (mode === 'embed' ? '.eco-google-chart' : '.eco-google-chart,[id^="embedChartHost"]');
const outDir = args.outDir || 'test-results/mini-debug';
const screenshotFile = args.screenshot || `mini-axis-${Date.now()}.png`;
const logFile = args.log || `axis-log-${Date.now()}.json`;
const viewportWidth = Number(args.width) || 1500;
const viewportHeight = Number(args.height) || 980;
const autoStart = args.autostart !== 'false' && !process.env.HARNESS_BASE_URL;
const rerender = args.rerender !== 'false';
const limit = Number(args.limit) || 0;

async function main() {
  const screenshotPath = path.resolve(process.cwd(), outDir, screenshotFile);
  const logPath = path.resolve(process.cwd(), outDir, logFile);
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await mkdir(path.dirname(logPath), { recursive: true });

  const serverController = autoStart ? startLocalServer(port) : null;
  try {
    await ensureHarnessReady(harnessBase);
    const result = await captureMiniAxis({
      url,
      mode,
      variants,
      selector,
      rerender,
      limit,
      screenshotPath,
      viewportWidth,
      viewportHeight
    });
    await writeFile(logPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      url,
      harnessBase,
      mode,
      variants,
      selector,
      limit,
      screenshot: path.relative(process.cwd(), screenshotPath),
      axisState: result.axisState,
      console: result.console,
      errors: result.errors
    }, null, 2));
    console.log(`Axis state written to ${logPath}`);
    if (result.errors.length) {
      console.warn('Encountered errors while running page:', result.errors);
    }
  } finally {
    if (serverController) {
      await serverController.stop();
    }
  }
}

async function captureMiniAxis({ url, mode, variants, selector, rerender, limit, screenshotPath, viewportWidth, viewportHeight }) {
  const consoleEntries = [];
  const errors = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight } });

  page.on('console', msg => {
    consoleEntries.push({
      type: msg.type(),
      text: msg.text(),
      ts: Date.now()
    });
  });

  page.on('pageerror', error => {
    errors.push({ message: error.message, stack: error.stack, ts: Date.now() });
  });

  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector(selector, { timeout: 20000 });
  if (rerender && mode === 'mini') {
    await page.evaluate(({ variants }) => {
      const tiles = [
        { shellId: 'embedTile1', chartId: 'embedChartHost1' },
        { shellId: 'embedTile2', chartId: 'embedChartHost2' },
        { shellId: 'embedTile3', chartId: 'embedChartHost3' },
        { shellId: 'embedTile4', chartId: 'embedChartHost4' },
        { shellId: 'embedTile5', chartId: 'embedChartHost5' },
        { shellId: 'embedTile6', chartId: 'embedChartHost6' },
        { shellId: 'embedTile7', chartId: 'embedChartHost7' },
        { shellId: 'embedTile8', chartId: 'embedChartHost8' }
      ];

      tiles.forEach((tile, idx) => {
        const host = document.getElementById(tile.chartId);
        const variant = variants[idx] || variants[variants.length - 1] || 'native-overlay';
        if (!host || typeof window.buildEmbedChart !== 'function' || typeof window.SAMPLE === 'undefined') {
          return;
        }
        host.innerHTML = '';
        window.buildEmbedChart(window.SAMPLE, tile.chartId, variant);
        const title = document.querySelector(`#${tile.shellId} h2`);
        if (title && title.firstChild) {
          title.firstChild.textContent = `Embed renderer ${idx + 1} (${variant}) `;
        }
      });
    }, { variants });
  }

  await page.waitForTimeout(Number(args.delayAfterRender || 1000));
  const axisState = await page.evaluate(({ variants, selector, mode, limit }) => {
    const hosts = Array.from(document.querySelectorAll(selector))
      .filter(node => !!node)
      .slice(0, limit && limit > 0 ? limit : undefined)
      .map((node, idx) => ({ node, idx }));

    const axisMatch = node => {
      if (!node) return false;
      const aria = (node.getAttribute('aria-label') || '').toLowerCase();
      const cls = (node.getAttribute('class') || '').toLowerCase();
      if (aria.includes('y-axis') || aria.includes('vertical axis') || aria.includes('v-axis')) return true;
      if (/\by[ -]?axis\b/.test(cls) || /\bv[ -]?axis\b/.test(cls)) return true;
      return false;
    };

    const isHidden = node => {
      if (!node) return null;
      const style = window.getComputedStyle(node);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0;
    };

    const hasDigits = text => /[0-9]/.test(text || '');

    return hosts.map(({ node, idx }) => {
      const card = node.closest('.eco-chart-card');
      const title = card?.querySelector('.eco-card-title')?.textContent?.trim() || null;
      const subtitle = card?.querySelector('.eco-card-unit')?.textContent?.trim() || null;
      const svg = node.querySelector('svg');
      const texts = svg ? Array.from(svg.querySelectorAll('text')) : [];
      const axisCandidates = svg ? Array.from(svg.querySelectorAll('g')) : [];
      const axisNode = axisCandidates.find(axisMatch) || null;
      const numericTexts = texts.filter(t => hasDigits(t.textContent || ''));
      const axisTextByAnchor = texts.filter(t => {
        const anchor = (t.getAttribute('text-anchor') || '').toLowerCase();
        return hasDigits(t.textContent || '') && (anchor === 'end' || anchor === 'start' || anchor === 'middle');
      });
      const bbox = axisNode && typeof axisNode.getBBox === 'function' ? axisNode.getBBox() : null;
      const overlayLayer = node.querySelector('.mini-axis-layer');
      const overlayLabelNodes = overlayLayer
        ? Array.from(overlayLayer.querySelectorAll('div')).filter(t => hasDigits(t.textContent || ''))
        : [];

      return {
        index: idx + 1,
        id: node.id || null,
        classes: node.className || null,
        title,
        subtitle,
        hasSvg: !!svg,
        hasAxis: !!axisNode || axisTextByAnchor.length > 0 || overlayLabelNodes.length > 0,
        axisHidden: overlayLayer ? isHidden(overlayLayer) : isHidden(axisNode),
        labelCount: axisNode ? Array.from(axisNode.querySelectorAll('text')).length : axisTextByAnchor.length,
        numericLabelCount: numericTexts.length,
        labels: axisNode
          ? Array.from(axisNode.querySelectorAll('text')).map(t => (t.textContent || '').trim()).filter(Boolean)
          : axisTextByAnchor.map(t => (t.textContent || '').trim()).filter(Boolean),
        overlayLayer: !!overlayLayer,
        overlayLabelCount: overlayLabelNodes.length,
        overlayLabels: overlayLabelNodes.map(t => (t.textContent || '').trim()).filter(Boolean),
        svgViewBox: svg?.getAttribute('viewBox') || null,
        axisBox: bbox ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : null,
        mode
      };
    });
  }, { variants, selector, mode, limit });

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();
  console.log(`Saved screenshot to ${screenshotPath}`);
  return { axisState, console: consoleEntries, errors };
}

async function ensureHarnessReady(baseUrl) {
  const probeUrl = new URL('/app/', baseUrl).toString();
  const timeoutMs = 8000;
  const retryDelayMs = 400;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(probeUrl, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok || response.status === 404) {
        return;
      }
      lastError = new Error(`Harness responded with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(`Unable to reach harness server at ${probeUrl}. Last error: ${lastError?.message || 'unknown'}`);
}

function startLocalServer(port) {
  const serverScript = path.join(projectRoot, 'scripts', 'serve.mjs');
  console.log('ℹ️  Auto-starting local harness server (npm run dev equivalent)...');
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HARNESS_AUTOSTART: '1'
    },
    stdio: 'inherit'
  });

  let stopping = false;

  child.on('exit', (code, signal) => {
    if (!stopping && code && code !== 0) {
      console.warn(`Harness server exited early (code=${code}, signal=${signal || 'none'})`);
    }
  });

  return {
    stop: () => stopLocalServer(child, () => { stopping = true; })
  };
}

function stopLocalServer(child, markStopping) {
  if (!child || child.killed || child.exitCode !== null) {
    return Promise.resolve();
  }
  markStopping();
  return new Promise(resolve => {
    const handleExit = () => resolve();
    child.once('exit', handleExit);
    child.kill('SIGINT');
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 5000);
    child.once('exit', () => clearTimeout(killTimer));
  });
}

function loadConfig() {
  const defaultPath = path.join(projectRoot, 'config', 'config.example.json');
  const localPath = path.join(projectRoot, 'config', 'config.local.json');
  const base = readJson(defaultPath, {});
  const overrides = readJson(localPath, {});
  return { ...base, ...overrides };
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Unable to read ${filePath}:`, error.message);
    return fallback;
  }
}

main().catch(error => {
  console.error('\nMini axis checker failed:', error);
  process.exitCode = 1;
});
