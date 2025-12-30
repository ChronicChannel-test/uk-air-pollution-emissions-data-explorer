#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 45000);
const ACTIVITY_BURST_INTERVAL_MS = 5000;
const HEARTBEAT_TARGETS = [
  { name: 'bubblechart', route: '/app/bubblechart/index.html', label: 'bubblechart_page_seen' },
  { name: 'linechart', route: '/app/linechart/index.html', label: 'linechart_page_seen' },
  { name: 'category-info', route: '/app/category-info/embed.html', label: 'category_info_page_seen' },
  { name: 'resources-embed', route: '/app/resources/embed.html', label: 'resources_embed_page_seen' },
  { name: 'user-guide', route: '/app/user-guide/embed.html', label: 'user_guide_page_seen' }
];

const analyticsProbeSource = `(() => {
  const monitor = {
    events: [],
    counts: {},
    lastEventAt: 0
  };
  window.__SBASE_EVENT_MONITOR__ = monitor;
  let observerActive = false;

  function record(channel, name, payload) {
    const safePayload = payload ? JSON.parse(JSON.stringify(payload)) : null;
    const timestamp = Date.now();
    monitor.events.push({
      channel,
      name,
      payload: safePayload,
      timestamp
    });
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
        if (!observerActive) {
          record(label || 'trackSystem', eventName, payload);
        }
        return originalSystem.apply(this, arguments);
      };
    }
    const originalInteraction = typeof api.trackInteraction === 'function' ? api.trackInteraction : null;
    if (originalInteraction) {
      api.trackInteraction = function(eventName, payload) {
        if (!observerActive) {
          record(label || 'trackInteraction', eventName, payload);
        }
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
  try {
    window.__SITE_ANALYTICS_EVENT_OBSERVER__ = event => {
      observerActive = true;
      const label = event && (event.event_label || event.event_type) ? (event.event_label || event.event_type) : 'observer_event';
      record('eventObserver', label, event || null);
    };
  } catch (error) {
    // Ignore observer hookup errors
  }
})();`;

const forceFocusSource = `(() => {
  const alwaysTrue = () => true;
  try {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: alwaysTrue
    });
  } catch (error) {
    try {
      document.hasFocus = alwaysTrue;
    } catch (_) {
      // ignore if we cannot override focus in this context
    }
  }
})();`;

await main().catch(error => {
  console.error('\nHeartbeat test runner failed:', error);
  process.exitCode = 1;
});

async function main() {
  const config = loadConfig();
  const harnessBase = process.env.HARNESS_BASE_URL || `http://localhost:${config.port || 4100}`;
  const targets = HEARTBEAT_TARGETS.map(target => ({
    ...target,
    url: new URL(target.route, harnessBase).toString()
  }));

  console.log(`Checking ${targets.length} heartbeat labels via ${harnessBase}`);

  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const target of targets) {
      const summary = await runHeartbeatScenario(browser, target);
      results.push(summary);
    }
  } finally {
    await browser.close();
  }

  printResults(results);

  if (results.some(result => !result.success)) {
    throw new Error('One or more heartbeat checks failed');
  }
}

async function runHeartbeatScenario(browser, target) {
  console.log(`\n▶ ${target.name} :: ${target.label}`);
  const context = await browser.newContext();
  await context.addInitScript({ content: analyticsProbeSource });
  await context.addInitScript({ content: forceFocusSource });
  const page = await context.newPage();
  const startedAt = Date.now();
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' });
    await waitForAnalyticsReady(page);
    const initialSnapshot = await page.evaluate(() => window.SiteAnalytics?.getHeartbeatSnapshot?.() || null);
    await burstActivity(page);
    const postActivitySnapshot = await page.evaluate(() => window.SiteAnalytics?.getHeartbeatSnapshot?.() || null);
    const heartbeat = await waitForHeartbeat(page, target.label);
    const monitor = heartbeat.monitor;
    const payload = pluckHeartbeatPayload(monitor, target.label);
    const elapsedMs = heartbeat.elapsedMs;
    return {
      name: target.name,
      label: target.label,
      url: target.url,
      success: heartbeat.success,
      elapsedMs,
      payload,
      monitor,
      focusState: heartbeat.focusState,
      visibilityState: heartbeat.visibilityState,
      initialSnapshot,
      postActivitySnapshot,
      heartbeatSnapshot: heartbeat.heartbeatSnapshot,
      error: heartbeat.error || null
    };
  } finally {
    await context.close();
  }
}

async function waitForAnalyticsReady(page) {
  await page.waitForFunction(() => {
    return Boolean(window.SiteAnalytics) && Boolean(window.__SBASE_EVENT_MONITOR__);
  }, null, { timeout: 15000 });
}

async function burstActivity(page) {
  await page.focus('body').catch(() => {});
  await page.click('body', { position: { x: 24, y: 24 } }).catch(() => {});
  const burstStart = Date.now();
  while (Date.now() - burstStart < ACTIVITY_BURST_INTERVAL_MS) {
    await page.mouse.move(50 + Math.random() * 200, 50 + Math.random() * 200, { steps: 2 });
    await page.mouse.wheel(0, 40);
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(150);
  }
}

async function waitForHeartbeat(page, expectedLabel) {
  const start = Date.now();
  try {
    await page.waitForFunction(
      label => {
        const monitor = window.__SBASE_EVENT_MONITOR__;
        if (!monitor) {
          return false;
        }
        return monitor.events.some(event => event.name === label);
      },
      expectedLabel,
      { timeout: HEARTBEAT_TIMEOUT_MS }
    );
    const snapshot = await page.evaluate(() => ({
      monitor: window.__SBASE_EVENT_MONITOR__ || null,
      focus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
      visibility: document.visibilityState || 'unknown',
      heartbeat: window.SiteAnalytics?.getHeartbeatSnapshot?.() || null
    }));
    return {
      success: true,
      elapsedMs: Date.now() - start,
      monitor: snapshot.monitor,
      focusState: snapshot.focus,
      visibilityState: snapshot.visibility,
      heartbeatSnapshot: snapshot.heartbeat
    };
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      monitor: window.__SBASE_EVENT_MONITOR__ || null,
      focus: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
      visibility: document.visibilityState || 'unknown',
      heartbeat: window.SiteAnalytics?.getHeartbeatSnapshot?.() || null
    }));
    return {
      success: false,
      elapsedMs: Date.now() - start,
      monitor: snapshot.monitor,
      focusState: snapshot.focus,
      visibilityState: snapshot.visibility,
      heartbeatSnapshot: snapshot.heartbeat,
      error
    };
  }
}

function pluckHeartbeatPayload(monitor, label) {
  if (!monitor || !Array.isArray(monitor.events)) {
    return null;
  }
  const event = monitor.events.find(entry => entry.name === label);
  return event ? event.payload || null : null;
}

function printResults(results) {
  console.log('\n=== heartbeat results ===');
  results.forEach(result => {
    const status = result.success ? 'PASS' : 'FAIL';
    const elapsedSeconds = result.elapsedMs ? (result.elapsedMs / 1000).toFixed(1) : 'n/a';
    const dwellSeconds = result.payload?.dwell_seconds ?? 'n/a';
    const heartbeatCount = result.payload?.heartbeat_count ?? 'n/a';
    const recorded = result.monitor?.counts?.[result.label] ?? 0;
    const focusNote = typeof result.focusState === 'boolean'
      ? ` :: focus=${result.focusState ? 'yes' : 'no'} vis=${result.visibilityState || 'unknown'}`
      : '';
    console.log(
      `- ${result.label.padEnd(26)} :: ${status} :: first heartbeat in ${elapsedSeconds}s :: dwell=${dwellSeconds}s :: count=${heartbeatCount} :: recorded=${recorded}${focusNote}`
    );
    if (!result.success && result.error) {
      console.log(`  • Error: ${result.error.message || String(result.error)}`);
      const eventNames = Array.isArray(result.monitor?.events)
        ? result.monitor.events.map(event => event.name).slice(0, 10)
        : [];
      if (eventNames.length) {
        console.log(`  • Seen events: ${eventNames.join(', ')}`);
      } else {
        console.log('  • Seen events: none');
      }
      if (result.heartbeatSnapshot) {
        console.log('  • Heartbeat snapshot:', JSON.stringify(result.heartbeatSnapshot));
      } else if (result.postActivitySnapshot || result.initialSnapshot) {
        console.log('  • Heartbeat snapshot unavailable; last snapshot:', JSON.stringify(result.postActivitySnapshot || result.initialSnapshot));
      }
    }
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
