#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.join(projectRoot, 'test-results', 'calculation-checks');
const DEFAULT_BUBBLE_PATH = '/app/bubblechart/embed.html';
const ACTIVITY_NAME = 'activity data';
const DEFAULT_BASE_URL = 'http://localhost:4100';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.base || process.env.HARNESS_BASE_URL || DEFAULT_BASE_URL;
  const outDir = path.resolve(projectRoot, args.outDir || DEFAULT_OUT_DIR);
  const snapshot = await loadSnapshot(args.snapshot);
  const dataset = normalizeSnapshot(snapshot);
  const scenarios = buildScenarios(dataset, {
    maxCategories: toNumber(args.maxCategories, 3),
    years: parseYearList(args.years),
    limit: toNumber(args.limit, null)
  });

  if (!scenarios.length) {
    console.error('No calculation scenarios available from default snapshot.');
    process.exit(1);
  }

  if (args.list === 'true' || args['list-only'] === 'true') {
    printScenarioList(scenarios, baseUrl);
    return;
  }

  await ensureHarnessReady(baseUrl);

  const browser = await chromium.launch({ headless: args.headless !== 'false' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const frame = await openBubbleFrame(page, baseUrl, args.path || DEFAULT_BUBBLE_PATH);
  await installComparisonCapture(frame);

  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(frame, dataset, scenario);
    results.push(result);
  }

  await browser.close();
  await saveResults(outDir, results, { baseUrl });
  printSummary(results, baseUrl);
}

function parseArgs(argv) {
  return argv.reduce((acc, arg) => {
    if (!arg.startsWith('--')) return acc;
    const eqIdx = arg.indexOf('=');
    const key = arg.slice(2, eqIdx === -1 ? undefined : eqIdx);
    const raw = eqIdx === -1 ? 'true' : arg.slice(eqIdx + 1);
    acc[key] = raw;
    return acc;
  }, {});
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseYearList(value) {
  if (!value) return null;
  return value
    .split(',')
    .map(v => Number(v.trim()))
    .filter(Number.isFinite);
}

async function loadSnapshot(customPath) {
  const snapshotPath = customPath
    ? path.resolve(projectRoot, customPath)
    : path.join(projectRoot, 'SharedResources', 'default-chart-data.json');
  try {
    const raw = await readFile(snapshotPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    const reason = error?.code === 'ENOENT'
      ? `Snapshot not found at ${snapshotPath}`
      : error.message || error;
    throw new Error(`Unable to load default snapshot: ${reason}`);
  }
}

function normalizeSnapshot(snapshot) {
  const data = snapshot?.data || snapshot || {};
  const pollutants = Array.isArray(data.pollutants) ? data.pollutants : [];
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
  const activity = pollutants.find(p => (p.pollutant || '').trim().toLowerCase() === ACTIVITY_NAME) || null;
  const years = Array.isArray(data.years) && data.years.length
    ? data.years
    : deriveYearsFromRows(rows);
  const yearKeys = Array.isArray(data.yearKeys) && data.yearKeys.length
    ? data.yearKeys
    : years.map(year => `f${year}`);

  const pollutantById = new Map();
  pollutants.forEach(p => pollutantById.set(Number(p.id), p));
  const categoryById = new Map();
  categories.forEach(c => categoryById.set(Number(c.id), c));

  const rowByKey = new Map();
  rows.forEach(row => {
    if (!row || typeof row !== 'object') return;
    const key = `${row.pollutant_id}:${row.category_id}`;
    rowByKey.set(key, row);
  });

  return {
    pollutants,
    categories,
    rows,
    activityId: activity?.id ?? null,
    years,
    yearKeys,
    pollutantById,
    categoryById,
    rowByKey
  };
}

function deriveYearsFromRows(rows) {
  const yearSet = new Set();
  (rows || []).forEach(row => {
    Object.keys(row || {}).forEach(key => {
      if (/^f\d{4}$/i.test(key)) {
        yearSet.add(Number(key.slice(1)));
      }
    });
  });
  return Array.from(yearSet).filter(Number.isFinite).sort((a, b) => b - a);
}

function buildScenarios(dataset, options = {}) {
  const maxCategories = Math.max(1, options.maxCategories || 3);
  const selectedYears = Array.isArray(options.years) && options.years.length
    ? options.years
    : dataset.years;
  const limit = Number.isFinite(options.limit) ? options.limit : null;

  const activityId = dataset.activityId;
  const usablePollutants = dataset.pollutants
    .filter(p => p.id !== activityId)
    .map(p => ({ id: Number(p.id), name: p.pollutant, unit: p.emission_unit || '' }));

  const scenarios = [];
  usablePollutants.forEach(pollutant => {
    const categoriesWithData = dataset.categories
      .filter(cat => categoryHasData(dataset, pollutant.id, cat.id, selectedYears));
    const combos = generateCombinations(categoriesWithData, maxCategories);

    selectedYears.forEach(year => {
      combos.forEach(combo => {
        const names = combo.map(cat => cat.category_title || cat.group_name).filter(Boolean);
        if (!names.length) return;
        scenarios.push({
          pollutantId: pollutant.id,
          pollutantName: pollutant.name,
          pollutantUnit: pollutant.unit || 'kt',
          year,
          categories: names
        });
      });
    });
  });

  const ordered = scenarios.sort((a, b) => {
    if (a.pollutantId !== b.pollutantId) return a.pollutantId - b.pollutantId;
    if (a.year !== b.year) return b.year - a.year;
    return a.categories.join(',').localeCompare(b.categories.join(','));
  });

  return limit ? ordered.slice(0, limit) : ordered;
}

function categoryHasData(dataset, pollutantId, categoryId, years) {
  const yearKeys = years.map(year => `f${year}`);
  const activityRow = dataset.rowByKey.get(`${dataset.activityId}:${categoryId}`);
  const pollutantRow = dataset.rowByKey.get(`${pollutantId}:${categoryId}`);
  if (!activityRow || !pollutantRow) return false;

  return yearKeys.some(key => Number.isFinite(activityRow[key]) && Number.isFinite(pollutantRow[key]));
}

function generateCombinations(items, maxSize) {
  const valid = items.filter(Boolean);
  const results = [];
  const upper = Math.min(maxSize, valid.length);
  for (let size = 1; size <= upper; size += 1) {
    backtrack(valid, size, 0, []);
  }
  return results;

  function backtrack(source, targetSize, start, current) {
    if (current.length === targetSize) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < source.length; i += 1) {
      current.push(source[i]);
      backtrack(source, targetSize, i + 1, current);
      current.pop();
    }
  }
}

function printScenarioList(scenarios, baseUrl) {
  console.log(`Calculation scenarios derived from snapshot (base: ${baseUrl}):`);
  scenarios.forEach((scenario, idx) => {
    console.log(`${idx + 1}. ${scenario.pollutantName} · ${scenario.year} · ${scenario.categories.join(', ')}`);
  });
}

async function ensureHarnessReady(baseUrl) {
  const probeUrl = new URL('/app/', baseUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(probeUrl, { method: 'HEAD', signal: controller.signal });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Harness responded with status ${response.status}`);
    }
  } catch (error) {
    const message = error?.message || error;
    throw new Error(`Unable to reach harness at ${probeUrl}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function openBubbleFrame(page, baseUrl, bubblePath) {
  const bubbleUrl = new URL(bubblePath, baseUrl).toString();
  const hostHtml = `<!doctype html><html><body><iframe id="bubbleFrame" src="${bubbleUrl}" style="width:100%;height:1200px;" loading="eager"></iframe></body></html>`;
  await page.setContent(hostHtml);
  const frame = await page.waitForSelector('#bubbleFrame');
  const bubbleFrame = await frame.contentFrame();
  if (!bubbleFrame) {
    throw new Error('Unable to resolve bubble iframe content');
  }
  await bubbleFrame.waitForSelector('#pollutantSelect', { timeout: 20000 });
  return bubbleFrame;
}

async function installComparisonCapture(frame) {
  await frame.waitForFunction(() => typeof window.updateComparisonStatement === 'function');
  await frame.evaluate(() => {
    if (window.__comparisonCaptureInstalled) return;
    const original = window.updateComparisonStatement;
    window.__capturedComparison = null;
    window.updateComparisonStatement = function(statement) {
      try {
        window.__capturedComparison = statement ? JSON.parse(JSON.stringify(statement)) : null;
      } catch (error) {
        window.__capturedComparison = statement || null;
      }
      return original.apply(this, arguments);
    };
    window.__comparisonCaptureInstalled = true;
  });
}

async function applySelections(frame, scenario) {
  await frame.evaluate((payload) => {
    window.__capturedComparison = null;
    const { pollutantId, year, categories } = payload;
    const pollutantSelect = document.getElementById('pollutantSelect');
    if (pollutantSelect) {
      pollutantSelect.value = String(pollutantId);
      pollutantSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const yearSelect = document.getElementById('yearSelect');
    if (yearSelect) {
      yearSelect.value = String(year);
      yearSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const container = document.getElementById('categoryContainer');
    if (container) {
      container.innerHTML = '';
      categories.forEach(name => {
        if (typeof window.addCategorySelector === 'function') {
          window.addCategorySelector(name, false);
        }
      });
    }

    if (typeof window.refreshButtons === 'function') {
      window.refreshButtons();
    }
    if (typeof window.updateChart === 'function') {
      window.updateChart();
    }
  }, scenario);

  await frame.waitForFunction((expectedCount, expectedYear, expectedPollutant) => {
    const current = window.ChartRenderer?.getCurrentChartData?.();
    if (!current || !Array.isArray(current.dataPoints)) return false;
    if (Number(current.year) !== Number(expectedYear)) return false;
    if (Number(current.pollutantId) !== Number(expectedPollutant)) return false;
    return current.dataPoints.length >= expectedCount;
  }, { timeout: 20000 }, scenario.categories.length, scenario.year, scenario.pollutantId);

  await frame.waitForTimeout(150);
}

async function runScenario(frame, dataset, scenario) {
  const expectedPoints = computeExpectedPoints(dataset, scenario);
  if (!expectedPoints.length) {
    return {
      scenario,
      status: 'skipped',
      reason: 'No matching data points in snapshot'
    };
  }

  const result = {
    scenario,
    status: 'passed',
    pointMismatches: [],
    statementMismatches: []
  };

  try {
    await applySelections(frame, scenario);
    const { dataPoints, statement, visible } = await frame.evaluate(() => ({
      dataPoints: window.ChartRenderer?.getCurrentChartData?.()?.dataPoints || [],
      statement: window.__capturedComparison || null,
      visible: (() => {
        const el = document.getElementById('comparisonDiv');
        return el ? el.style.display !== 'none' : false;
      })()
    }));

    result.pointMismatches = comparePoints(expectedPoints, dataPoints);

    if (scenario.categories.length >= 2) {
      const expectedStatement = computeExpectedStatement(dataset, scenario, expectedPoints);
      if (!visible && expectedStatement) {
        result.statementMismatches.push('Comparison statement hidden but expected');
      } else if (expectedStatement) {
        result.statementMismatches.push(...compareStatements(expectedStatement, statement));
      }
    }

    if (result.pointMismatches.length || result.statementMismatches.length) {
      result.status = 'failed';
    }
  } catch (error) {
    result.status = 'failed';
    result.error = error?.message || String(error);
  }

  return result;
}

function computeExpectedPoints(dataset, scenario) {
  const yearKey = `f${scenario.year}`;
  return scenario.categories.map(name => {
    const category = findCategory(dataset, name);
    if (!category) return null;
    const activityRow = dataset.rowByKey.get(`${dataset.activityId}:${category.id}`);
    const pollutantRow = dataset.rowByKey.get(`${scenario.pollutantId}:${category.id}`);
    if (!activityRow || !pollutantRow) return null;
    const actValue = Number(activityRow[yearKey]);
    const pollutantValue = Number(pollutantRow[yearKey]);
    if (!Number.isFinite(actValue) || !Number.isFinite(pollutantValue)) return null;
    return {
      categoryId: Number(category.id),
      categoryName: category.category_title || category.group_name || '',
      actDataValue: actValue,
      pollutantValue
    };
  }).filter(Boolean);
}

function findCategory(dataset, name) {
  const target = (name || '').toLowerCase();
  return dataset.categories.find(cat => (cat.category_title || cat.group_name || '').toLowerCase() === target) || null;
}

function comparePoints(expected, actual, tolerance = 1e-6) {
  const mismatches = [];
  const actualById = new Map();
  (actual || []).forEach(point => actualById.set(Number(point.categoryId), point));

  expected.forEach(point => {
    const observed = actualById.get(Number(point.categoryId));
    if (!observed) {
      mismatches.push(`Missing category ${point.categoryName} (${point.categoryId})`);
      return;
    }

    if (!withinTolerance(point.actDataValue, observed.actDataValue, tolerance)) {
      mismatches.push(`Activity mismatch for ${point.categoryName}: expected ${point.actDataValue}, saw ${observed.actDataValue}`);
    }
    if (!withinTolerance(point.pollutantValue, observed.pollutantValue, tolerance)) {
      mismatches.push(`Pollution mismatch for ${point.categoryName}: expected ${point.pollutantValue}, saw ${observed.pollutantValue}`);
    }
  });

  return mismatches;
}

function withinTolerance(expected, actual, tolerance) {
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  if (expected === 0) return Math.abs(actual) <= tolerance;
  return Math.abs(expected - actual) <= Math.abs(expected) * 1e-6 + tolerance;
}

function compareStatements(expected, actual, tolerance = 1e-6) {
  if (!actual) return ['Comparison statement missing'];
  const differences = [];
  const checks = [
    ['pollutionRatio', expected.pollutionRatio, actual.pollutionRatio],
    ['energyRatio', expected.energyRatio, actual.energyRatio],
    ['replacementPollution', expected.replacementPollution, actual.replacementPollution]
  ];

  checks.forEach(([label, exp, obs]) => {
    if (!Number.isFinite(exp) && !Number.isFinite(obs)) return;
    if (!withinTolerance(exp, obs, tolerance)) {
      differences.push(`${label} mismatch: expected ${formatNumber(exp)}, saw ${formatNumber(obs)}`);
    }
  });

  if (expected.pollutionRelation && expected.pollutionRelation !== actual.pollutionRelation) {
    differences.push(`pollutionRelation mismatch: expected ${expected.pollutionRelation}, saw ${actual.pollutionRelation || 'none'}`);
  }

  return differences;
}

function computeExpectedStatement(dataset, scenario, points) {
  if (!points || points.length < 2) return null;
  const enriched = points.map(p => ({
    ...p,
    emissionFactor: calculateEmissionFactor(p)
  }));

  const { leader: pollutionLeader, follower: pollutionFollower } = selectLeaderFollower(enriched, dp => normalizeNumber(dp.pollutantValue));
  const { leader: energyLeader, follower: energyFollower } = selectLeaderFollower(enriched, dp => normalizeNumber(dp.actDataValue));
  const { leader: efLeader, follower: efFollower } = selectLeaderFollower(enriched, dp => normalizeNumber(dp.emissionFactor));

  let leftLeader = energyFollower;
  let leftFollower = energyLeader;
  if (!leftLeader || !leftFollower) {
    leftLeader = efLeader || pollutionLeader;
    leftFollower = efFollower || pollutionFollower;
  }

  const pollutionRatioSourceLeader = leftLeader && leftFollower ? leftLeader : pollutionLeader;
  const pollutionRatioSourceFollower = leftLeader && leftFollower ? leftFollower : pollutionFollower;
  let pollutionRatio = NaN;
  let pollutionRelation = null;
  if (pollutionRatioSourceLeader && pollutionRatioSourceFollower) {
    const leaderPollution = normalizeNumber(pollutionRatioSourceLeader.pollutantValue);
    const followerPollution = normalizeNumber(pollutionRatioSourceFollower.pollutantValue);
    if (Number.isFinite(leaderPollution) && Number.isFinite(followerPollution)) {
      if (leaderPollution < followerPollution) {
        pollutionRatio = safeRatio(followerPollution, leaderPollution);
        pollutionRelation = 'lower';
      } else {
        pollutionRatio = safeRatio(leaderPollution, followerPollution);
        pollutionRelation = 'higher';
      }
    }
  }

  const energyRatio = energyLeader && energyFollower
    ? safeRatio(energyLeader.actDataValue, energyFollower.actDataValue)
    : NaN;

  const warningPolluter = energyFollower;
  const warningBaseline = energyLeader;
  const replacementPollution = estimateReplacementPollution(warningPolluter, warningBaseline);

  return {
    pollutionRatio,
    pollutionRelation,
    energyRatio,
    replacementPollution,
    pollutantUnit: scenario.pollutantUnit || 'kt',
    activityUnit: dataset.pollutantById.get(dataset.activityId)?.emission_unit || 'TJ'
  };
}

function selectLeaderFollower(list, accessor) {
  if (!Array.isArray(list) || list.length < 2) return { leader: null, follower: null };
  const ranked = [...list].sort((a, b) => {
    const aVal = Number(accessor(a));
    const bVal = Number(accessor(b));
    const aValid = Number.isFinite(aVal);
    const bValid = Number.isFinite(bVal);
    if (!aValid && !bValid) return 0;
    if (!aValid) return 1;
    if (!bValid) return -1;
    return bVal - aVal;
  });
  const leader = ranked[0];
  const follower = ranked[1];
  const leaderValue = Number(accessor(leader));
  const followerValue = Number(accessor(follower));
  return {
    leader: Number.isFinite(leaderValue) ? leader : null,
    follower: Number.isFinite(followerValue) ? follower : null
  };
}

function safeRatio(numerator, denominator) {
  const num = Number(numerator);
  const den = Number(denominator);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return Infinity;
  return num / den;
}

function calculateEmissionFactor(dataPoint) {
  if (!dataPoint) return null;
  const pollutionValue = normalizeNumber(dataPoint.pollutantValue);
  const activityValue = normalizeNumber(dataPoint.actDataValue);
  if (!Number.isFinite(pollutionValue) || !Number.isFinite(activityValue) || activityValue === 0) {
    return null;
  }
  return pollutionValue / activityValue;
}

function estimateReplacementPollution(replacementSource, baselineSource) {
  if (!replacementSource || !baselineSource) return null;
  const replacementPollution = normalizeNumber(replacementSource.pollutantValue);
  const replacementActivity = normalizeNumber(replacementSource.actDataValue);
  const baselineActivity = normalizeNumber(baselineSource.actDataValue);
  if (!Number.isFinite(replacementPollution) || !Number.isFinite(replacementActivity) || replacementActivity === 0) {
    return null;
  }
  const emissionFactor = calculateEmissionFactor({ pollutantValue: replacementPollution, actDataValue: replacementActivity });
  const totalActivity = sumActivityValues(replacementActivity, baselineActivity);
  if (!Number.isFinite(emissionFactor) || !Number.isFinite(totalActivity) || totalActivity <= 0) {
    return null;
  }
  const replacement = emissionFactor * totalActivity;
  return Number.isFinite(replacement) ? replacement : null;
}

function sumActivityValues(...values) {
  return values.reduce((total, value) => {
    const numeric = normalizeNumber(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return total;
    }
    return total + numeric;
  }, 0);
}

function normalizeNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return NaN;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : parseFloat(cleaned);
  }
  return NaN;
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toPrecision(6) : 'NaN';
}

async function saveResults(outDir, results, meta) {
  await mkdir(outDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    meta,
    totals: {
      passed: results.filter(r => r.status === 'passed').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      total: results.length
    },
    results
  };
  const logPath = path.join(outDir, `calculation-checks-${Date.now()}.json`);
  await writeFile(logPath, JSON.stringify(payload, null, 2));
  console.log(`Calculation results written to ${path.relative(projectRoot, logPath)}`);
}

function printSummary(results, baseUrl) {
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  console.log(`\nCalculation audit completed against ${baseUrl}`);
  console.log(`   Passed : ${passed}`);
  console.log(`   Failed : ${failed}`);
  console.log(`   Skipped: ${skipped}`);
  if (failed) {
    console.log('\nFailures:');
    results.filter(r => r.status === 'failed').forEach(r => {
      const label = `${r.scenario.pollutantName} · ${r.scenario.year} · ${r.scenario.categories.join(', ')}`;
      console.log(` - ${label}`);
      (r.pointMismatches || []).forEach(msg => console.log(`    • ${msg}`));
      (r.statementMismatches || []).forEach(msg => console.log(`    • ${msg}`));
      if (r.error) {
        console.log(`    • Error: ${r.error}`);
      }
    });
  }
}

main().catch(error => {
  console.error('Calculation harness failed:', error);
  process.exitCode = 1;
});
