#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const SUPABASE_DUPLICATE_IDENTIFIER = "Identifier 'supabase' has already been declared";

const analyticsProbeSource = `(() => {
  const monitor = {
    events: [],
    counts: {},
    lastEventAt: 0
  };
  window.__SBASE_EVENT_MONITOR__ = monitor;

  function resolveRootMonitor() {
    try {
      const topWindow = window.top;
      if (!topWindow) {
        return null;
      }
      if (!topWindow.__SBASE_EVENT_MONITOR_ROOT__) {
        topWindow.__SBASE_EVENT_MONITOR_ROOT__ = {
          events: [],
          counts: {},
          lastEventAt: 0
        };
      }
      return topWindow.__SBASE_EVENT_MONITOR_ROOT__;
    } catch (error) {
      return null;
    }
  }

  const rootMonitor = resolveRootMonitor();

  function publishToRoot(entry) {
    if (!rootMonitor || rootMonitor === monitor) {
      return;
    }
    try {
      rootMonitor.events.push(entry);
      rootMonitor.counts[entry.name] = (rootMonitor.counts[entry.name] || 0) + 1;
      rootMonitor.lastEventAt = entry.timestamp;
    } catch (error) {
      // ignore aggregation issues across browsing contexts
    }
  }

  const contextLabel = (() => {
    try {
      if (window === window.top) {
        return 'top-window';
      }
      const frame = window.frameElement;
      if (!frame) {
        return 'iframe';
      }
      const token = frame.id || frame.getAttribute('name');
      return token ? 'iframe:' + token : 'iframe';
    } catch (error) {
      return 'unknown-context';
    }
  })();

  function record(channel, name, payload) {
    const safePayload = payload ? JSON.parse(JSON.stringify(payload)) : null;
    const timestamp = Date.now();
    const entry = {
      channel,
      name,
      payload: safePayload,
      timestamp,
      context: contextLabel
    };
    monitor.events.push(entry);
    monitor.counts[name] = (monitor.counts[name] || 0) + 1;
    monitor.lastEventAt = timestamp;
    publishToRoot(entry);
  }

  function wrapAnalytics(api, label) {
    if (!api || api.__sbaseMonitorWrapped) {
      return;
    }
    const originalSystem = typeof api.trackSystem === 'function' ? api.trackSystem : null;
    if (originalSystem) {
      api.trackSystem = function(eventName, payload) {
        record(label || 'trackSystem', eventName, payload);
        return originalSystem.apply(this, arguments);
      };
    }
    const originalInteraction = typeof api.trackInteraction === 'function' ? api.trackInteraction : null;
    if (originalInteraction) {
      api.trackInteraction = function(eventName, payload) {
        record(label || 'trackInteraction', eventName, payload);
        return originalInteraction.apply(this, arguments);
      };
    }
    api.__sbaseMonitorWrapped = true;
  }

  function wrapLegacy(legacy) {
    if (!legacy || legacy.__sbaseMonitorWrapped) {
      return;
    }
    const original = typeof legacy.trackAnalytics === 'function' ? legacy.trackAnalytics : null;
    if (original) {
      legacy.trackAnalytics = function(client, eventName, payload) {
        record('legacyTrackAnalytics', eventName, payload);
        return original.apply(this, arguments);
      };
    }
    legacy.__sbaseMonitorWrapped = true;
  }

  function interceptProperty(obj, prop, hook) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
    if (descriptor && !descriptor.configurable) {
      hook(obj[prop]);
      return;
    }
    let current = obj[prop];
    Object.defineProperty(obj, prop, {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(value) {
        current = value;
        hook(value);
      }
    });
    if (current) {
      hook(current);
    }
  }

  interceptProperty(window, 'SiteAnalytics', api => wrapAnalytics(api, 'SiteAnalytics'));
  interceptProperty(window, 'Analytics', api => wrapLegacy(api));
})();`;

await main().catch(error => {
  console.error('\nScenario runner failed:', error);
  process.exitCode = 1;
});

async function main() {
  const config = loadConfig();
  const harnessBase = process.env.HARNESS_BASE_URL || `http://localhost:${config.port || 4100}`;
  const urls = {
    bubble: new URL('/app/bubblechart/index.html', harnessBase).toString(),
    line: new URL('/app/linechart/index.html', harnessBase).toString(),
    app: new URL('/app/index.html', harnessBase).toString()
  };
  const serverController = process.env.HARNESS_BASE_URL ? null : startLocalServer(config);
  try {
    await ensureHarnessReady(harnessBase);
    const snapshot = await loadSnapshot(config);
    const normalized = normalizeSnapshot(snapshot);
    const scenarioMeta = deriveScenarioInputs(snapshot, normalized);
    const scenarios = buildScenarios(urls, scenarioMeta);

    console.log(`Running ${scenarios.length} scenarios (bubble: ${urls.bubble}, line: ${urls.line})`);
    const results = await runScenarios(scenarios);
    printSummary(results);
  } finally {
    if (serverController) {
      await serverController.stop();
    }
  }
}

async function ensureHarnessReady(harnessBase) {
  const probeUrl = new URL('/app/', harnessBase).toString();
  const timeoutMs = 7000;
  const retryDelayMs = 350;
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
    await delay(retryDelayMs);
  }

  const hint = process.env.HARNESS_BASE_URL
    ? 'Ensure the URL is reachable from this machine.'
    : 'Start the local harness server with "npm run dev" in CIC-test-data-explorer-testing-harness.';
  throw new Error(`Unable to reach harness server at ${probeUrl}. ${hint} Last error: ${lastError?.message || 'unknown'}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startLocalServer(config) {
  const serverScript = path.join(projectRoot, 'scripts', 'serve.mjs');
  console.log('ℹ️  Auto-starting local harness server (npm run dev equivalent)...');
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(config.port || 4100),
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

async function loadSnapshot(config) {
  const explorerRoot = resolveExplorerRoot(config);
  const snapshotPath = path.join(explorerRoot, 'SharedResources', 'default-chart-data.json');
  try {
    const raw = await readFile(snapshotPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error([
        `Unable to load ${snapshotPath}.`,
        'Verify default-chart-data.json exists in SharedResources or set "dataExplorerRoot" in config/config.local.json to the full explorer path.'
      ].join(' '));
    }
    throw error;
  }
}

function resolveExplorerRoot(config) {
  const candidate = config.dataExplorerRoot
    ? path.resolve(projectRoot, config.dataExplorerRoot)
    : path.resolve(projectRoot, '../CIC-test-uk-air-pollution-emissions-data-explorer');
  if (!fs.existsSync(candidate)) {
    throw new Error([
      `dataExplorerRoot not found at ${candidate}.`,
      'Set "dataExplorerRoot" in config/config.local.json to your uk-air-pollution-emissions-data-explorer checkout,',
      'or clone it beside the harness directory.'
    ].join(' '));
  }
  return candidate;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot) {
    return { pollutants: [], categories: [], rows: [] };
  }
  const data = snapshot.data || snapshot;
  const categories = Array.isArray(data.categories)
    ? data.categories
    : Array.isArray(data.groups)
      ? data.groups
      : [];
  const rows = Array.isArray(data.timeseries)
    ? data.timeseries
    : Array.isArray(data.rows)
      ? data.rows
      : Array.isArray(data.data)
        ? data.data
        : [];
  return {
    pollutants: Array.isArray(data.pollutants) ? data.pollutants : [],
    categories,
    rows
  };
}

function deriveScenarioInputs(snapshot, normalized) {
  const defaults = snapshot?.defaults?.bubbleChart || {};
  const defaultPollutantName = (defaults.pollutant || '').toLowerCase();
  const excludedPollutants = new Set(
    [defaults.pollutant, defaults.activityPollutant]
      .filter(Boolean)
      .map(value => value.toLowerCase())
  );

  const pollutantCandidates = normalized.pollutants.filter(entry => {
    const name = (entry.pollutant || '').trim().toLowerCase();
    return name && !excludedPollutants.has(name);
  });

  if (!pollutantCandidates.length) {
    throw new Error('Unable to find alternate pollutant for scenarios');
  }

  const defaultCategoryNames = new Set(
    Array.isArray(defaults.categories) ? defaults.categories.map(name => name.toLowerCase()) : []
  );

  const categoryCandidates = normalized.categories.filter(entry => {
    const title = ((entry.category_title || entry.group_name || '')).trim();
    if (!title) {
      return false;
    }
    const normalizedTitle = title.toLowerCase();
    if (normalizedTitle === 'all') {
      return false;
    }
    if (defaultCategoryNames.has(normalizedTitle)) {
      return false;
    }
    if (entry.has_activity_data === false) {
      return false;
    }
    return Number.isFinite(entry.id);
  });

  if (categoryCandidates.length < 2) {
    throw new Error('Need at least two alternate categories to build scenarios');
  }

  const years = deriveAvailableYears(normalized.rows);
  if (!years.length) {
    throw new Error('Unable to derive year list from snapshot data');
  }
  const defaultYear = defaults.year || 2023;
  const altYear = years.find(year => year !== defaultYear) ?? years[0];
  const altYear2 = years.find(year => year !== defaultYear && year !== altYear) ?? altYear;

  return {
    defaults: {
      pollutant: defaults.pollutant,
      year: defaultYear,
      categories: Array.from(defaultCategoryNames)
    },
    primaryPollutant: pollutantCandidates[0],
    secondaryPollutant: pollutantCandidates[1] || pollutantCandidates[0],
    categories: categoryCandidates,
    altYear,
    altYear2,
    latestYear: years[0],
    earliestYear: years[years.length - 1],
    years
  };
}

function deriveAvailableYears(rows) {
  const yearSet = new Set();
  (rows || []).slice(0, 10).forEach(row => {
    if (!row || typeof row !== 'object') {
      return;
    }
    Object.keys(row).forEach(key => {
      if (/^f\d{4}$/i.test(key)) {
        const value = Number(key.slice(1));
        if (Number.isFinite(value)) {
          yearSet.add(value);
        }
      }
    });
  });
  return Array.from(yearSet).sort((a, b) => b - a);
}

function buildScenarios(urls, meta) {
  const buildBubbleUrl = (params = {}) => `${urls.bubble}${buildQuery(params)}`;
  const buildLineUrl = (params = {}) => `${urls.line}${buildQuery(params)}`;
  const buildAppUrl = (params = {}) => `${urls.app}${buildQuery(params)}`;
  const [catA, catB, catC, catD] = padCategories(meta.categories, 4);
  const lineStartYear = meta.earliestYear || meta.altYear || meta.altYear2;
  const lineEndYear = meta.latestYear || meta.altYear2 || meta.altYear;

  const scenarios = [
    {
      name: 'full-app-hard-refresh',
      description: 'Load full explorer shell to ensure shared Supabase modules coexist',
      url: buildAppUrl({ page: 'bubblechart' }),
      expectNoSupabaseIdentifierErrors: true
    },
    {
      name: 'default-initial',
      description: 'Default bubble chart load (snapshot + hydration)',
      url: buildBubbleUrl()
    },
    {
      name: 'default-repeat',
      description: 'Second default load to confirm no duplicate events',
      url: buildBubbleUrl()
    },
    {
      name: 'pollutant-override',
      description: `pollutantId=${meta.primaryPollutant.id}`,
      url: buildBubbleUrl({ pollutantId: meta.primaryPollutant.id })
    },
    {
      name: 'category-pair',
      description: `categoryIds=${catA.id},${catB.id}`,
      url: buildBubbleUrl({ categoryIds: `${catA.id},${catB.id}` })
    },
    {
      name: 'year-shift',
      description: `year=${meta.altYear}`,
      url: buildBubbleUrl({ year: meta.altYear })
    },
    {
      name: 'mixed-overrides',
      description: 'pollutant + categories + year override',
      url: buildBubbleUrl({
        pollutantId: meta.secondaryPollutant.id,
        categoryIds: `${catC.id},${catD.id}`,
        year: meta.altYear2
      })
    },
    {
      name: 'share-export-flows',
      description: 'open share dialog and trigger download buttons',
      url: buildBubbleUrl(),
      postLoad: page => exerciseShareAndExportFlow(page, 'bubblechart')
    },
    {
      name: 'line-app-hard-refresh',
      description: 'Load explorer shell with line chart view to guard shared Supabase globals',
      url: buildAppUrl({ page: 'linechart' }),
      expectNoSupabaseIdentifierErrors: true
    },
    {
      name: 'line-default',
      description: 'Default line chart load (snapshot + hydration)',
      url: buildLineUrl()
    },
    {
      name: 'line-range-override',
      description: 'line pollutant + categories + start/end override',
      url: buildLineUrl({
        pollutant_id: meta.secondaryPollutant.id,
        category_ids: `${catA.id},${catB.id},${catC.id}`,
        start_year: lineStartYear,
        end_year: lineEndYear
      })
    },
    {
      name: 'line-share-export',
      description: 'open share dialog and trigger download buttons (line chart)',
      url: buildLineUrl(),
      postLoad: page => exerciseShareAndExportFlow(page, 'linechart')
    }
  ];

  return scenarios;
}

function padCategories(categories, size) {
  const list = categories.slice();
  if (!list.length) {
    throw new Error('No categories provided');
  }
  while (list.length < size) {
    list.push(categories[list.length % categories.length]);
  }
  return list.slice(0, size);
}

function buildQuery(params = {}) {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) {
    return '';
  }
  const searchParams = new URLSearchParams();
  for (const [key, value] of entries) {
    searchParams.set(key, String(value));
  }
  return `?${searchParams.toString()}`;
}

async function exerciseShareAndExportFlow(page, chartId = 'bubblechart') {
  console.log(`  • exercising share/share-export controls (${chartId})`);
  const frame = await resolveChartFrame(page, chartId);
  await waitForControlEnabled(frame, '#shareBtn');
  await frame.click('#shareBtn');
  await frame.waitForSelector('#closeShareBtn', { state: 'visible', timeout: 12000 });
  await frame.click('#closeShareBtn');
  await frame.waitForSelector('#closeShareBtn', { state: 'detached', timeout: 7000 }).catch(() => {});
  await triggerFileDownload(page, frame, '#downloadBtn', 'PNG');
  await triggerFileDownload(page, frame, '#downloadCSVBtn', 'CSV');
  await triggerFileDownload(page, frame, '#downloadXLSXBtn', 'XLSX');
}

async function resolveChartFrame(page, chartId = 'bubblechart') {
  const selectors = {
    bubblechart: '#bubblechart-iframe',
    linechart: '#linechart-iframe'
  };
  const selector = selectors[chartId] || selectors.bubblechart;
  const iframeHandle = await page.waitForSelector(selector, { timeout: 15000 });
  const frame = await iframeHandle.contentFrame();
  if (!frame) {
    throw new Error(`Unable to resolve ${chartId} iframe content frame`);
  }
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}

function waitForControlEnabled(frame, selector, timeout = 15000) {
  return frame.waitForSelector(`${selector}:not([disabled])`, { timeout });
}

async function triggerFileDownload(page, frame, selector, label) {
  await waitForControlEnabled(frame, selector);
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  await frame.click(selector);
  const download = await downloadPromise;
  if (download) {
    await download.path().catch(() => null);
    console.log(`  • ${label} download triggered (${download.suggestedFilename() || 'unnamed'})`);
  } else {
    console.warn(`  • ${label} download did not produce a file event`);
  }
}

async function runScenarios(scenarios) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const scenario of scenarios) {
      console.log(`\n▶ ${scenario.name} :: ${scenario.description}`);
      const context = await browser.newContext({ acceptDownloads: true });
      await context.addInitScript({ content: analyticsProbeSource });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on('console', message => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });
      page.on('pageerror', error => {
        consoleErrors.push(error?.message || String(error));
      });
      try {
        await page.goto(scenario.url, { waitUntil: 'domcontentloaded' });
        await waitForSbaseEvents(page);
        if (typeof scenario.postLoad === 'function') {
          await scenario.postLoad(page);
        }
        const summary = await page.evaluate(() => window.__SBASE_EVENT_MONITOR_ROOT__ || window.__SBASE_EVENT_MONITOR__ || null);
        if (scenario.expectNoSupabaseIdentifierErrors) {
          const duplicateError = consoleErrors.find(text => typeof text === 'string' && text.includes(SUPABASE_DUPLICATE_IDENTIFIER));
          if (duplicateError) {
            throw new Error(`Scenario "${scenario.name}" detected Supabase redeclaration: ${duplicateError}`);
          }
        }
        results.push({ ...scenario, summary, consoleErrors });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

async function waitForSbaseEvents(page) {
  const idleThresholdMs = 1500;
  const maxWaitMs = 20000;
  try {
    await page.waitForFunction(
      idleMs => {
        const monitor = window.__SBASE_EVENT_MONITOR_ROOT__ || window.__SBASE_EVENT_MONITOR__;
        if (!monitor) {
          return false;
        }
        const count = monitor.counts?.sbase_data_loaded || 0;
        if (count === 0) {
          return false;
        }
        const last = monitor.lastEventAt || 0;
        return (Date.now() - last) > idleMs;
      },
      idleThresholdMs,
      { timeout: maxWaitMs }
    );
  } catch (error) {
    console.warn('  • waitForFunction timed out before idle state reached');
  }
  await page.waitForTimeout(750);
}

function printSummary(results) {
  console.log('\n=== sbase_data_loaded counts ===');
  results.forEach(result => {
    const count = result.summary?.counts?.sbase_data_loaded || 0;
    const payloads = (result.summary?.events || [])
      .filter(event => event.name === 'sbase_data_loaded')
      .map(event => {
        const source = event.payload?.source || 'unknown';
        const mode = event.payload?.loadMode || 'n/a';
        return `${source} (${mode})`;
      });
    console.log(`- ${result.name.padEnd(18)} :: ${count} event(s) :: ${payloads.join(', ') || 'no payloads recorded'}`);
  });
}
