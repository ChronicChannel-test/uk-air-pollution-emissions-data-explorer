#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const analyticsProbeSource = `(() => {
  const monitor = {
    events: [],
    counts: {},
    lastEventAt: 0
  };
  window.__SBASE_EVENT_MONITOR__ = monitor;

  function record(channel, name, payload) {
    const safePayload = payload ? JSON.parse(JSON.stringify(payload)) : null;
    const timestamp = Date.now();
    monitor.events.push({ channel, name, payload: safePayload, timestamp });
    monitor.counts[name] = (monitor.counts[name] || 0) + 1;
    monitor.lastEventAt = timestamp;
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
  interceptProperty(window, 'supabaseModule', api => {
    if (!api || api.__sbaseMonitorWrapped) {
      return;
    }
    const original = typeof api.trackAnalytics === 'function' ? api.trackAnalytics : null;
    if (original) {
      api.trackAnalytics = function(eventName, payload) {
        record('supabaseModule', eventName, payload);
        return original.apply(this, arguments);
      };
    }
    api.__sbaseMonitorWrapped = true;
  });
})();`;

const clipboardShimSource = `(() => {
  class ClipboardItemShim {
    constructor(items) {
      this.items = items;
    }
  }
  if (typeof window.ClipboardItem === 'undefined') {
    window.ClipboardItem = ClipboardItemShim;
  }
  const writes = [];
  const clipboardApi = {
    writeText: async (text) => {
      writes.push({ type: 'text', text });
      return true;
    },
    write: async (items) => {
      writes.push({ type: 'items', items });
      return true;
    },
    __writes: writes
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    get() {
      return clipboardApi;
    }
  });
})();`;

const emailShimSource = `(() => {
  if (!window.EmailShareHelper) {
    window.EmailShareHelper = {
      composeEmail(payload = {}) {
        return {
          subject: payload.subject || 'Shared chart',
          body: 'stub',
          ...payload
        };
      },
      openEmailClient() {
        window.__emailShareInvoked = true;
      },
      stripProtocol(url) {
        return url ? url.replace(/^(https?:\\/\\/)/i, '') : url;
      }
    };
  }
})();`;

await main().catch(error => {
  console.error('\nShare event runner failed:', error);
  process.exitCode = 1;
});

async function main() {
  const config = loadConfig();
  const harnessBase = process.env.HARNESS_BASE_URL || `http://localhost:${config.port || 4100}`;
  const baseUrl = new URL(harnessBase).toString().replace(/\/$/, '');
  const origin = new URL(baseUrl).origin;
  const targets = buildTargets(baseUrl);

  console.log(`Running share-event scenarios against ${baseUrl}`);
  const browser = await chromium.launch({ headless: true });
  const allResults = [];
  try {
    for (const target of targets) {
      const result = await runTarget(browser, origin, target);
      allResults.push(result);
      printTargetSummary(result);
    }
  } finally {
    await browser.close();
  }

  const failures = collectFailures(allResults);
  if (failures.length) {
    console.log('\nMissing share events:');
    failures.forEach(failure => {
      console.log(`- ${failure.chart} :: ${failure.event} (expected from ${failure.action})`);
    });
  } else {
    console.log('\nAll expected share events were recorded.');
  }
}

function loadConfig() {
  const defaultPath = path.join(projectRoot, 'config', 'config.example.json');
  const localPath = path.join(projectRoot, 'config', 'config.local.json');
  return {
    ...readJson(defaultPath, {}),
    ...readJson(localPath, {})
  };
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`Unable to read ${filePath}:`, error.message);
    return fallback;
  }
}

function buildTargets(baseUrl) {
  const bubbleUrl = new URL('/app/bubblechart/index.html', baseUrl).toString();
  const lineUrl = new URL('/app/linechart/index.html', baseUrl).toString();
  return [
    {
      chart: 'bubblechart',
      url: bubbleUrl,
      expectedEvents: [
        { name: 'bubblechart_share_url_copied', actionKey: 'copy-url' },
        { name: 'bubblechart_share_png_copied', actionKey: 'copy-png' },
        { name: 'bubblechart_share_email_opened', actionKey: 'email-share' }
      ],
      actions: [
        { key: 'open-dialog', label: 'Open Share Dialog', selector: '#shareBtn', waitAfter: 800, waitForSelector: '#copyUrlBtn' },
        { key: 'copy-url', label: 'Copy URL', selector: '#copyUrlBtn', waitAfter: 800 },
        { key: 'copy-png', label: 'Copy PNG', selector: '#copyPngBtn', waitAfter: 1500 },
        { key: 'email-share', label: 'Email Share', selector: '#emailShareBtn', waitAfter: 800 }
      ]
    },
    {
      chart: 'linechart',
      url: lineUrl,
      expectedEvents: [
        { name: 'linechart_share_button_click', actionKey: 'open-dialog' },
        { name: 'linechart_share_url_copied', actionKey: 'copy-url' },
        { name: 'linechart_share_png_copied', actionKey: 'copy-png' },
        { name: 'linechart_share_email_opened', actionKey: 'email-share' }
      ],
      actions: [
        { key: 'open-dialog', label: 'Open Share Dialog', selector: '#shareBtn', waitAfter: 800, waitForSelector: '#copyUrlBtn' },
        { key: 'copy-url', label: 'Copy URL', selector: '#copyUrlBtn', waitAfter: 800 },
        { key: 'copy-png', label: 'Copy PNG', selector: '#copyPngBtn', waitAfter: 1500 },
        { key: 'email-share', label: 'Email Share', selector: '#emailShareBtn', waitAfter: 800 }
      ]
    }
  ];
}

async function runTarget(browser, origin, target) {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await context.addInitScript({ content: analyticsProbeSource });
  await context.addInitScript({ content: clipboardShimSource });
  await context.addInitScript({ content: emailShimSource });
  const page = await context.newPage();

  const actionResults = [];
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' });

    for (const action of target.actions) {
      const result = await performAction(page, action);
      actionResults.push(result);
    }

    await page.waitForTimeout(1000);
    const summary = await page.evaluate(() => window.__SBASE_EVENT_MONITOR__ || null);
    return {
      chart: target.chart,
      summary,
      actions: actionResults,
      expectedEvents: target.expectedEvents
    };
  } finally {
    await context.close();
  }
}

async function performAction(page, action) {
  const record = { ...action, status: 'pending' };
  try {
    await page.waitForSelector(action.selector, { state: 'visible', timeout: 20000 });
    await page.click(action.selector, { timeout: 15000 });
    if (action.waitForSelector) {
      await page.waitForSelector(action.waitForSelector, { state: 'visible', timeout: 20000 });
    }
    await page.waitForTimeout(action.waitAfter || 500);
    record.status = 'ok';
  } catch (error) {
    record.status = 'error';
    record.error = error.message;
  }
  return record;
}

function printTargetSummary(result) {
  const counts = buildEventCounts(result.summary);
  console.log(`\n=== ${result.chart} share events ===`);
  result.expectedEvents.forEach(({ name, actionKey }) => {
    const count = counts[name] || 0;
    console.log(`- ${name}: ${count}`);
  });
  result.actions.forEach(action => {
    if (action.status !== 'ok') {
      console.log(`  • Action "${action.label}" failed: ${action.error}`);
    }
  });
}

function buildEventCounts(summary) {
  const counts = {};
  if (!summary || !Array.isArray(summary.events)) {
    return counts;
  }
  summary.events.forEach(event => {
    counts[event.name] = (counts[event.name] || 0) + 1;
  });
  return counts;
}

function collectFailures(results) {
  const failures = [];
  results.forEach(result => {
    const counts = buildEventCounts(result.summary);
    result.expectedEvents.forEach(({ name, actionKey }) => {
      const count = counts[name] || 0;
      if (count === 0) {
        const action = result.actions.find(action => action.key === actionKey);
        failures.push({ chart: result.chart, event: name, action: action?.label || 'unknown' });
      }
    });
  });
  return failures;
}
