#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://localhost:4100';
const DEFAULT_PAGE_PATH = '/app/EcoReplacesAll/embed.html';
const DEFAULT_OUT_DIR = path.join(projectRoot, 'test-results', 'eco-calculation-checks');
const DEFAULT_SNAPSHOT_PATH = path.join(projectRoot, 'SharedResources', 'default-chart-data.json');
const MIN_ECO_YEAR = 2017;
const FIREPLACE_PATTERN = /(fireplace|stove|chiminea|burner|grate|open fire|log burner)/i;
const EXCLUDED_FIREPLACE_CATEGORY_IDS = new Set([20, 65]);
const FIREPLACES_ALL_CATEGORY_ID = 27;
const DOMESTIC_COMBUSTION_CATEGORY_ID = 13;
const GAS_BOILERS_CATEGORY_ID = 37;
const ECO_READY_CATEGORY_ID = 20;
const ECO_CATEGORY_PATTERN = /ecodesign.+ready.+burn/i;
const ACTIVITY_NAME = 'activity data';
const EXCLUDED_POLLUTANT_ID = 62;
const EXCLUDED_POLLUTANT_NAME = 'Carbon Dioxide as Carbon';
const EXCLUDED_POLLUTANT_TAG = '16PAH';

await main().catch(error => {
  console.error('\nEco calculation audit failed:', error);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.base || process.env.HARNESS_BASE_URL || DEFAULT_BASE_URL;
  const pagePath = args.path || DEFAULT_PAGE_PATH;
  const outDir = path.resolve(projectRoot, args.outDir || DEFAULT_OUT_DIR);
  const dataset = await loadDataset(args.snapshot || DEFAULT_SNAPSHOT_PATH);
  const scenarios = buildScenarios(dataset, {
    fireplaceId: toNumber(args.fireplace, null),
    pollutantId: toNumber(args.pollutant, null),
    scope: args.scope,
    year: toNumber(args.year, null),
    limit: toNumber(args.limit, null)
  });

  if (!scenarios.length) {
    console.error('No eco calculation scenarios are available.');
    process.exit(1);
  }

  if (args.list === 'true' || args['list-only'] === 'true') {
    printScenarioList(scenarios, baseUrl, pagePath);
    return;
  }

  await ensureHarnessReady(baseUrl);

  const browser = await chromium.launch({ headless: args.headless !== 'false' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await openEcoPage(page, baseUrl, pagePath);

  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(page, dataset, scenario);
    results.push(result);
  }

  await browser.close();
  await saveResults(outDir, results, { baseUrl, pagePath, snapshot: dataset.snapshotPath });
  printSummary(results, baseUrl, pagePath);
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

async function loadDataset(snapshotPath) {
  const resolved = path.resolve(projectRoot, snapshotPath);
  try {
    const raw = await readFile(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    const dataset = normalizeDataset(parsed);
    dataset.snapshotPath = resolved;
    return dataset;
  } catch (error) {
    const reason = error?.code === 'ENOENT'
      ? `Snapshot not found at ${resolved}`
      : error.message || error;
    throw new Error(`Unable to load dataset: ${reason}`);
  }
}

function normalizeDataset(snapshot) {
  const data = snapshot?.data || snapshot || {};
  const pollutants = Array.isArray(data.pollutants) ? data.pollutants : [];
  const categories = Array.isArray(data.categories)
    ? data.categories
    : Array.isArray(data.groups)
      ? data.groups
      : [];
  const timeseries = Array.isArray(data.timeseries)
    ? data.timeseries
    : Array.isArray(data.rows)
      ? data.rows
      : Array.isArray(data.data)
        ? data.data
        : [];
  const pollutantById = new Map();
  pollutants.forEach(p => pollutantById.set(Number(p.id), p));
  const categoryById = new Map();
  categories.forEach(c => categoryById.set(Number(c.id), c));
  const timeseriesIndex = createTimeseriesIndex(timeseries);
  const activityPollutantId = findActivityPollutantId(pollutants);
  const ecoCategoryId = findEcoCategoryId(categories);
  const years = extractYearList(timeseries).filter(y => y >= MIN_ECO_YEAR);

  return {
    raw: snapshot,
    pollutants,
    pollutantById,
    categories,
    categoryById,
    timeseries,
    timeseriesIndex,
    activityPollutantId,
    ecoCategoryId,
    years
  };
}

function findActivityPollutantId(pollutants) {
  const match = (pollutants || []).find(p => (p.pollutant || '').trim().toLowerCase() === ACTIVITY_NAME);
  return match ? Number(match.id) : null;
}

function findEcoCategoryId(categories) {
  if (!Array.isArray(categories)) {
    return null;
  }
  const byId = categories.find(cat => Number(cat?.id) === Number(ECO_READY_CATEGORY_ID));
  if (byId) {
    return Number(byId.id);
  }
  const byPattern = categories.find(cat => ECO_CATEGORY_PATTERN.test(String(cat?.category_title || cat?.group_name || '').toLowerCase()));
  return byPattern ? Number(byPattern.id) : null;
}

function extractYearList(rows) {
  const pattern = /^f(\d{4})$/;
  const yearSet = new Set();
  (rows || []).forEach(row => {
    if (!row) return;
    Object.keys(row).forEach(key => {
      const match = pattern.exec(key);
      if (match) {
        yearSet.add(Number(match[1]));
      }
    });
  });
  return Array.from(yearSet).sort((a, b) => a - b);
}

function buildScenarios(dataset, filters = {}) {
  const fireplaces = (dataset.categories || []).filter(cat => {
    const title = cat?.category_title || cat?.group_name || '';
    if (!FIREPLACE_PATTERN.test(String(title))) return false;
    return !EXCLUDED_FIREPLACE_CATEGORY_IDS.has(Number(cat.id));
  });
  const fireplaceList = Number.isFinite(filters.fireplaceId)
    ? fireplaces.filter(cat => Number(cat.id) === Number(filters.fireplaceId))
    : fireplaces;

  const pollutantList = (dataset.pollutants || []).filter(p => {
    if (!p || p.id == null || !p.pollutant) return false;
    if (Number(p.id) === Number(dataset.activityPollutantId)) return false;
    if (isCarbonDioxideAsCarbon(p)) return false;
    if (Number.isFinite(filters.pollutantId) && Number(p.id) !== Number(filters.pollutantId)) return false;
    return true;
  });

  const years = Array.isArray(dataset.years) && dataset.years.length ? dataset.years : [2023];
  const yearList = Number.isFinite(filters.year) ? years.filter(y => Number(y) === Number(filters.year)) : years;
  const scopes = filters.scope === 'domestic'
    ? ['domestic']
    : filters.scope === 'fireplace'
      ? ['fireplace']
      : ['fireplace', 'domestic'];

  const scenarios = [];
  fireplaceList.forEach(fireplace => {
    const fireplaceId = Number(fireplace.id);
    yearList.forEach(year => {
      scopes.forEach(scope => {
        pollutantList.forEach(pollutant => {
          scenarios.push({
            fireplaceId,
            fireplaceName: fireplace.category_title || fireplace.group_name || String(fireplaceId),
            year: Number(year),
            scope,
            pollutantId: Number(pollutant.id),
            pollutantName: pollutant.pollutant,
            unit: pollutant.emission_unit || 'tonne'
          });
        });
      });
    });
  });

  if (Number.isFinite(filters.limit) && filters.limit > 0) {
    return scenarios.slice(0, filters.limit);
  }
  return scenarios;
}

function printScenarioList(scenarios, baseUrl, pagePath) {
  console.log(`Eco calculation scenarios derived from snapshot (base: ${baseUrl}${pagePath}):`);
  scenarios.forEach((scenario, idx) => {
    console.log(`${idx + 1}. ${scenario.scope} · ${scenario.year} · ${scenario.pollutantName} · ${scenario.fireplaceName}`);
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

async function openEcoPage(page, baseUrl, pagePath) {
  const url = new URL(pagePath, baseUrl).toString();
  await page.goto(url);
  await page.waitForSelector('#ecoPollutantSelect', { timeout: 20000 });
  await page.waitForSelector('#ecoFireplaceSelect option:not([value=""])', { timeout: 20000 });
}

async function runScenario(page, dataset, scenario) {
  const preflight = computeExpectedScenario(dataset, scenario);
  if (!preflight || !preflight.ready) {
    return {
      scenario,
      status: 'skipped',
      reason: preflight?.reason || 'Missing data'
    };
  }

  try {
    await applySelection(page, scenario);
    const inclusionAssessment = await resolveInclusionAssessment(page, dataset, scenario);
    const expected = computeExpectedScenario(dataset, scenario, inclusionAssessment);
    if (!expected || !expected.ready) {
      return {
        scenario,
        status: 'skipped',
        reason: expected?.reason || 'Missing data'
      };
    }
    const actual = await extractCardData(page, scenario.pollutantName);
    if (!actual) {
      return {
        scenario,
        status: 'failed',
        mismatches: ['Pollutant card not rendered']
      };
    }

    const mismatches = compareScenario(expected, actual);
    return {
      scenario,
      status: mismatches.length ? 'failed' : 'passed',
      mismatches,
      details: {
        expected: expected.display,
        actual
      }
    };
  } catch (error) {
    return {
      scenario,
      status: 'failed',
      mismatches: [error?.message || String(error)]
    };
  }
}

async function applySelection(page, scenario) {
  await page.evaluate((payload) => {
    const { pollutantId, fireplaceId, year, scope } = payload;
    const pollutantSelect = document.getElementById('ecoPollutantSelect');
    if (pollutantSelect) {
      pollutantSelect.value = String(pollutantId);
      pollutantSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const fireplaceSelect = document.getElementById('ecoFireplaceSelect');
    if (fireplaceSelect) {
      fireplaceSelect.value = String(fireplaceId);
      fireplaceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const yearSelect = document.getElementById('ecoYearSelect');
    if (yearSelect) {
      yearSelect.value = String(year);
      yearSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const scopeButton = document.querySelector(`[data-eco-scope="${scope}"]`);
    if (scopeButton && scopeButton.getAttribute('aria-pressed') !== 'true') {
      scopeButton.click();
    }
  }, scenario);

  await page.waitForFunction((pollutantName) => {
    const card = document.querySelector('.eco-chart-card');
    if (!card) return false;
    const title = card.querySelector('.eco-title-name');
    return title && title.textContent && title.textContent.trim().toLowerCase() === String(pollutantName || '').toLowerCase();
  }, { timeout: 20000 }, scenario.pollutantName);

  await page.waitForTimeout(200);
}

async function extractCardData(page, pollutantName) {
  return page.evaluate((name) => {
    const cards = Array.from(document.querySelectorAll('.eco-chart-card'));
    const card = cards.find(el => {
      const title = el.querySelector('.eco-title-name');
      if (!title || !title.textContent) return false;
      return title.textContent.trim().toLowerCase() === String(name || '').toLowerCase();
    }) || cards[0];
    if (!card) return null;
    const tooltip = card.querySelector('.eco-mini-tooltip');
    const rows = tooltip ? Array.from(tooltip.querySelectorAll('.eco-mini-tooltip__row')).map(row => ({
      label: row.querySelector('.eco-mini-tooltip__cell--label')?.textContent?.trim() || '',
      values: Array.from(row.querySelectorAll('.eco-mini-tooltip__value, .eco-mini-tooltip__total-value')).map(el => el.textContent.trim())
    })) : [];
    const percentText = card.querySelector('.eco-delta-percentage')?.textContent?.trim() || '';
    const deltaText = card.querySelector('.eco-delta-value')?.textContent?.trim() || '';
    const energy = {
      replacement: document.getElementById('ecoEnergyReplacementValue')?.textContent?.trim() || '',
      fireplace: document.getElementById('ecoEnergyFireplaceValue')?.textContent?.trim() || '',
      eco: document.getElementById('ecoEnergyEcoValue')?.textContent?.trim() || ''
    };
    return { percentText, deltaText, rows, energy };
  }, pollutantName);
}

async function resolveInclusionAssessment(page, dataset, scenario) {
  const ecoCategoryId = Number(dataset?.ecoCategoryId);
  const fireplaceCategoryId = Number(scenario?.fireplaceId);
  if (!Number.isFinite(ecoCategoryId) || !Number.isFinite(fireplaceCategoryId)) {
    return { included: null, reason: 'invalid-id' };
  }
  if (!page) {
    return { included: null, reason: 'unchecked' };
  }
  try {
    const result = await page.evaluate(async ({ ecoCategoryId, fireplaceCategoryId }) => {
      const utils = window.EcoReplacementUtils;
      if (!utils || typeof utils.assessCategoryInclusion !== 'function') {
        return { included: null, reason: 'missing-utils' };
      }
      try {
        const options = window.SharedDataLoader ? { sharedLoader: window.SharedDataLoader } : undefined;
        const assessment = await utils.assessCategoryInclusion(ecoCategoryId, fireplaceCategoryId, options);
        if (assessment && typeof assessment === 'object') {
          return assessment;
        }
        return { included: null, reason: 'missing-result' };
      } catch (error) {
        return { included: null, reason: 'error' };
      }
    }, { ecoCategoryId, fireplaceCategoryId });
    return result || { included: null, reason: 'missing-result' };
  } catch (error) {
    return { included: null, reason: 'error' };
  }
}

function compareScenario(expected, actual) {
  const mismatches = [];
  const parsed = parseTooltip(actual.rows);
  if (!parsed) {
    mismatches.push('Tooltip values missing');
    return mismatches;
  }

  Object.keys(expected.scaledValues).forEach(key => {
    const expectedValue = expected.scaledValues[key];
    if (!Number.isFinite(expectedValue)) {
      return;
    }
    const observed = parsed[key];
    if (!Number.isFinite(observed)) {
      mismatches.push(`Missing tooltip value for ${key}`);
      return;
    }
    if (!withinTolerance(expectedValue, observed)) {
      mismatches.push(`Value mismatch for ${key}: expected ${formatNumber(expectedValue)}, saw ${formatNumber(observed)}`);
    }
  });

  const expectedPercent = expected.percentChange;
  const observedPercent = parsePercent(actual.percentText);
  if (Number.isFinite(expectedPercent)) {
    if (!Number.isFinite(observedPercent)) {
      mismatches.push('Percent change missing');
    } else if (!withinTolerance(expectedPercent, observedPercent, 1e-3)) {
      mismatches.push(`Percent change mismatch: expected ${formatNumber(expectedPercent)}%, saw ${formatNumber(observedPercent)}%`);
    }
  }

  if (Number.isFinite(expected.deltaScaled)) {
    const observedDelta = parseNumber(actual.deltaText);
    if (!Number.isFinite(observedDelta)) {
      mismatches.push('Delta value missing');
    } else if (!withinTolerance(expected.deltaScaled, observedDelta)) {
      mismatches.push(`Delta value mismatch: expected ${formatNumber(expected.deltaScaled)}, saw ${formatNumber(observedDelta)}`);
    }
  }

  const energyValues = {
    replacement: parseNumber(actual.energy.replacement),
    fireplace: parseNumber(actual.energy.fireplace),
    eco: parseNumber(actual.energy.eco)
  };
  if (Number.isFinite(expected.energy.replacement)) {
    if (!Number.isFinite(energyValues.replacement) || !withinTolerance(expected.energy.replacement, energyValues.replacement, 1e-3)) {
      mismatches.push(`Energy replacement mismatch: expected ${formatNumber(expected.energy.replacement)}, saw ${formatNumber(energyValues.replacement)}`);
    }
  }
  if (Number.isFinite(expected.energy.fireplace)) {
    if (!Number.isFinite(energyValues.fireplace) || !withinTolerance(expected.energy.fireplace, energyValues.fireplace, 1e-3)) {
      mismatches.push(`Energy fireplace mismatch: expected ${formatNumber(expected.energy.fireplace)}, saw ${formatNumber(energyValues.fireplace)}`);
    }
  }
  if (Number.isFinite(expected.energy.eco)) {
    if (!Number.isFinite(energyValues.eco) || !withinTolerance(expected.energy.eco, energyValues.eco, 1e-3)) {
      mismatches.push(`Energy eco mismatch: expected ${formatNumber(expected.energy.eco)}, saw ${formatNumber(energyValues.eco)}`);
    }
  }

  return mismatches;
}

function computeExpectedScenario(dataset, scenario, inclusionAssessment = { included: null, reason: 'unchecked' }) {
  const index = dataset.timeseriesIndex;
  const activityId = dataset.activityPollutantId;
  if (!index || !Number.isFinite(activityId) || !Number.isFinite(dataset.ecoCategoryId)) {
    return { ready: false, reason: 'Missing eco baseline references' };
  }
  const yearKey = resolveYearKey(scenario.year);
  const ecoEnergy = getTimeseriesValue(index, activityId, dataset.ecoCategoryId, yearKey);
  const fireplaceEnergy = getTimeseriesValue(index, activityId, scenario.fireplaceId, yearKey);
  if (!Number.isFinite(ecoEnergy) && !Number.isFinite(fireplaceEnergy)) {
    return { ready: false, reason: 'No activity data for scenario' };
  }

  const energyProfile = computeEnergyProfile({
    timeseriesIndex: index,
    ecoCategoryId: dataset.ecoCategoryId,
    fireplaceCategoryId: scenario.fireplaceId,
    activityPollutantId: activityId,
    year: scenario.year,
    inclusionAssessment
  });
  const scenarioResult = computeReplacementScenario({
    pollutantId: scenario.pollutantId,
    timeseriesIndex: index,
    ecoCategoryId: dataset.ecoCategoryId,
    fireplaceCategoryId: scenario.fireplaceId,
    baselineFireplaceCategoryId: FIREPLACES_ALL_CATEGORY_ID,
    activityPollutantId: activityId,
    year: scenario.year,
    energyProfile
  });

  if (!scenarioResult || !Number.isFinite(scenarioResult.ecoEmission) || !Number.isFinite(scenarioResult.replacementEmission)) {
    return { ready: false, reason: 'Missing emissions data' };
  }

  const baseline = resolveScenarioBaseline(dataset, scenario, scenarioResult);
  if (!baseline) {
    return { ready: false, reason: 'Unable to resolve baseline' };
  }

  const percentChange = computeReplacementPercent(baseline);
  const remainderAdjusted = computeRemainderAdjusted(scenarioResult);
  const selectedEmissionAdjusted = computeSelectedEmissionAdjusted(scenarioResult);
  const domesticExtras = scenario.scope === 'domestic'
    ? computeDomesticExtras(dataset, scenario, scenarioResult)
    : { other: NaN, gas: NaN, totalDomestic: NaN };
  const totals = computeTotals({
    scenario,
    scenarioResult,
    remainderAdjusted,
    selectedEmissionAdjusted,
    domesticExtras
  });
  const scaleInfo = computeUnitScale(scenario.unit || 'tonne', buildScaleValues({
    scenario,
    scenarioResult,
    remainderAdjusted,
    domesticExtras
  }));
  const factor = scaleInfo.factor || 1;

  const scaledValues = {
    remainder: remainderAdjusted * factor,
    fireplace: selectedEmissionAdjusted * factor,
    eco: scenarioResult.ecoEmission * factor,
    replacement: scenarioResult.replacementEmission * factor,
    totalCurrent: totals.current * factor,
    totalReplacement: totals.replacement * factor
  };
  if (scenario.scope === 'domestic') {
    scaledValues.gas = domesticExtras.gas * factor;
    scaledValues.other = domesticExtras.other * factor;
  }

  const deltaScaled = Math.abs((baseline.baseline - baseline.replacement) * factor);

  return {
    ready: true,
    percentChange,
    deltaScaled,
    scaledValues,
    energy: {
      replacement: coerceNonNegative(getTimeseriesValue(index, activityId, scenario.scope === 'domestic' ? DOMESTIC_COMBUSTION_CATEGORY_ID : FIREPLACES_ALL_CATEGORY_ID, yearKey)),
      fireplace: coerceNonNegative(energyProfile.fireplaceEnergy),
      eco: coerceNonNegative(energyProfile.ecoEnergy)
    },
    display: {
      percentChange,
      deltaScaled,
      scaledValues,
      energy: {
        replacement: coerceNonNegative(getTimeseriesValue(index, activityId, scenario.scope === 'domestic' ? DOMESTIC_COMBUSTION_CATEGORY_ID : FIREPLACES_ALL_CATEGORY_ID, yearKey)),
        fireplace: coerceNonNegative(energyProfile.fireplaceEnergy),
        eco: coerceNonNegative(energyProfile.ecoEnergy)
      }
    }
  };
}

function computeEnergyProfile(options = {}) {
  const {
    timeseriesIndex,
    ecoCategoryId,
    fireplaceCategoryId,
    activityPollutantId,
    year,
    inclusionAssessment
  } = options;
  const yearKey = resolveYearKey(year);
  const ecoEnergy = getTimeseriesValue(timeseriesIndex, activityPollutantId, ecoCategoryId, yearKey);
  const fireplaceEnergy = getTimeseriesValue(timeseriesIndex, activityPollutantId, fireplaceCategoryId, yearKey);
  const inclusion = inclusionAssessment || { included: null, reason: 'unchecked' };
  const replacementEnergy = inclusion?.included
    ? normalizeNumber(fireplaceEnergy)
    : sumActivityValues(ecoEnergy, fireplaceEnergy);
  return {
    ecoEnergy: normalizeNumber(ecoEnergy),
    fireplaceEnergy: normalizeNumber(fireplaceEnergy),
    replacementEnergy: normalizeNumber(replacementEnergy),
    inclusion
  };
}

function computeReplacementScenario(options = {}) {
  const {
    pollutantId,
    timeseriesIndex,
    ecoCategoryId,
    fireplaceCategoryId,
    baselineFireplaceCategoryId,
    year,
    activityPollutantId,
    energyProfile
  } = options;
  if (!timeseriesIndex || !Number.isFinite(Number(pollutantId))) {
    return null;
  }
  const profile = energyProfile || computeEnergyProfile({
    timeseriesIndex,
    ecoCategoryId,
    fireplaceCategoryId,
    activityPollutantId,
    year
  });
  const yearKey = resolveYearKey(year);
  const ecoEmission = getTimeseriesValue(timeseriesIndex, pollutantId, ecoCategoryId, yearKey);
  const fireplaceEmission = getTimeseriesValue(timeseriesIndex, pollutantId, fireplaceCategoryId, yearKey);
  const baselineFireplaceEmission = getTimeseriesValue(
    timeseriesIndex,
    pollutantId,
    Number.isFinite(baselineFireplaceCategoryId) ? baselineFireplaceCategoryId : fireplaceCategoryId,
    yearKey
  );
  const baselineFireplaceEnergy = Number.isFinite(activityPollutantId)
    ? getTimeseriesValue(
      timeseriesIndex,
      activityPollutantId,
      Number.isFinite(baselineFireplaceCategoryId) ? baselineFireplaceCategoryId : fireplaceCategoryId,
      yearKey
    )
    : NaN;
  const remainderEmission = Math.max(0, normalizeNumber(baselineFireplaceEmission) - normalizeNumber(fireplaceEmission));
  const remainderEnergy = Math.max(0, normalizeNumber(baselineFireplaceEnergy) - normalizeNumber(profile.fireplaceEnergy));
  const ecoEmissionFactor = calculateEmissionFactor({ pollutantValue: ecoEmission, actDataValue: profile.ecoEnergy });
  const replacementEmission = (Number.isFinite(ecoEmissionFactor)
    && Number.isFinite(profile.replacementEnergy)
    && profile.replacementEnergy > 0)
    ? ecoEmissionFactor * profile.replacementEnergy
    : null;

  return {
    pollutantId: Number(pollutantId),
    ecoEmission: normalizeNumber(ecoEmission),
    fireplaceEmission: normalizeNumber(fireplaceEmission),
    baselineFireplaceEmission: normalizeNumber(baselineFireplaceEmission),
    fireplaceRemainderEmission: remainderEmission,
    baselineFireplaceEnergy: normalizeNumber(baselineFireplaceEnergy),
    fireplaceRemainderEnergy: remainderEnergy,
    replacementEmission: normalizeNumber(replacementEmission),
    ecoEmissionFactor: Number.isFinite(ecoEmissionFactor) ? ecoEmissionFactor : null,
    energyProfile: profile
  };
}

function resolveScenarioBaseline(dataset, scenario, result) {
  const inclusion = result.energyProfile && result.energyProfile.inclusion;
  const yearKey = resolveYearKey(scenario.year);
  if (scenario.scope === 'domestic' && dataset.timeseriesIndex) {
    const domesticTotal = coerceNonNegative(getTimeseriesValue(dataset.timeseriesIndex, scenario.pollutantId, DOMESTIC_COMBUSTION_CATEGORY_ID, yearKey));
    const gasTotal = coerceNonNegative(getTimeseriesValue(dataset.timeseriesIndex, scenario.pollutantId, GAS_BOILERS_CATEGORY_ID, yearKey));
    const fireplacesTotal = coerceNonNegative(getTimeseriesValue(dataset.timeseriesIndex, scenario.pollutantId, FIREPLACES_ALL_CATEGORY_ID, yearKey));
    const ecoScope = coerceNonNegative(result.ecoEmission);
    const fireplaceScope = coerceNonNegative(result.fireplaceEmission);
    const ecoIncluded = inclusion && inclusion.included === true;
    const remainderAdjusted = Math.max(0, fireplacesTotal - (fireplaceScope + (ecoIncluded ? 0 : ecoScope)));
    const replacementValue = coerceNonNegative(result.replacementEmission);
    if (Number.isFinite(domesticTotal) && Number.isFinite(replacementValue)) {
      const otherTotal = Math.max(0, domesticTotal - (gasTotal + fireplacesTotal));
      return {
        baseline: domesticTotal,
        replacement: gasTotal + otherTotal + replacementValue + remainderAdjusted,
        useAbsolute: true
      };
    }
  }

  const baselineScope = Number(result.baselineFireplaceEmission);
  const replacementScope = Number(result.replacementEmission);
  if (Number.isFinite(baselineScope) && Number.isFinite(replacementScope)) {
    const fireplaceScope = Number(result.fireplaceEmission);
    const ecoScope = Number(result.ecoEmission);
    const remainderScope = Number(result.fireplaceRemainderEmission);
    const ecoIncluded = inclusion && inclusion.included === true;
    const remainderAdjusted = Math.max(0, baselineScope - (coerceNonNegative(fireplaceScope) + (ecoIncluded ? 0 : coerceNonNegative(ecoScope))));
    const remainderValue = Number.isFinite(remainderAdjusted) ? remainderAdjusted : (Number.isFinite(remainderScope) ? remainderScope : 0);
    return { baseline: baselineScope, replacement: replacementScope + remainderValue, useAbsolute: true };
  }

  const fireplace = Number(result.fireplaceEmission);
  const replacement = Number(result.replacementEmission);
  if (!Number.isFinite(fireplace) || !Number.isFinite(replacement)) {
    return null;
  }
  const ecoEmission = Number(result.ecoEmission);
  const isExcluded = inclusion && inclusion.included === false;
  let baseline = fireplace;
  let useAbsolute = true;
  if (isExcluded && Number.isFinite(ecoEmission)) {
    baseline = ecoEmission + fireplace;
    useAbsolute = false;
  }
  return { baseline, replacement, useAbsolute };
}

function computeReplacementPercent(comparison) {
  if (!comparison) {
    return NaN;
  }
  const baseline = comparison.baseline;
  const replacement = comparison.replacement;
  const denominator = comparison.useAbsolute ? Math.abs(baseline) : baseline;
  if (denominator === 0) {
    if (replacement === baseline) {
      return 0;
    }
    return replacement > baseline ? Infinity : -Infinity;
  }
  return ((replacement - baseline) / denominator) * 100;
}

function computeRemainderAdjusted(result) {
  const inclusion = result.energyProfile && result.energyProfile.inclusion;
  const baseline = coerceNonNegative(result.baselineFireplaceEmission);
  const fireplace = coerceNonNegative(result.fireplaceEmission);
  const eco = coerceNonNegative(result.ecoEmission);
  const ecoIncluded = inclusion && inclusion.included === true;
  if (!Number.isFinite(baseline)) {
    return coerceNonNegative(result.fireplaceRemainderEmission);
  }
  return Math.max(0, baseline - (fireplace + (ecoIncluded ? 0 : eco)));
}

function computeSelectedEmissionAdjusted(result) {
  const inclusion = result.energyProfile && result.energyProfile.inclusion;
  const ecoIncluded = inclusion && inclusion.included === true;
  const fireplace = coerceNonNegative(result.fireplaceEmission);
  const eco = coerceNonNegative(result.ecoEmission);
  if (ecoIncluded) {
    return Math.max(0, fireplace - eco);
  }
  return fireplace;
}

function computeDomesticExtras(dataset, scenario, result) {
  const yearKey = resolveYearKey(scenario.year);
  const domesticTotal = coerceNonNegative(getTimeseriesValue(dataset.timeseriesIndex, scenario.pollutantId, DOMESTIC_COMBUSTION_CATEGORY_ID, yearKey));
  const gasTotal = coerceNonNegative(getTimeseriesValue(dataset.timeseriesIndex, scenario.pollutantId, GAS_BOILERS_CATEGORY_ID, yearKey));
  const fireplacesTotal = coerceNonNegative(getTimeseriesValue(dataset.timeseriesIndex, scenario.pollutantId, FIREPLACES_ALL_CATEGORY_ID, yearKey));
  const otherTotal = Math.max(0, domesticTotal - (gasTotal + fireplacesTotal));
  return {
    totalDomestic: domesticTotal,
    gas: gasTotal,
    other: otherTotal
  };
}

function computeTotals({ scenarioResult, remainderAdjusted, selectedEmissionAdjusted, domesticExtras, scenario }) {
  const isDomestic = scenario.scope === 'domestic';
  const eco = coerceNonNegative(scenarioResult.ecoEmission);
  const replacement = coerceNonNegative(scenarioResult.replacementEmission);
  const gas = isDomestic ? coerceNonNegative(domesticExtras.gas) : 0;
  const other = isDomestic ? coerceNonNegative(domesticExtras.other) : 0;

  const current = selectedEmissionAdjusted + eco + remainderAdjusted + gas + other;
  const replacementTotal = replacement + remainderAdjusted + gas + other;
  return { current, replacement: replacementTotal };
}

function buildScaleValues({ scenarioResult, remainderAdjusted, domesticExtras, scenario }) {
  const values = [
    scenarioResult.ecoEmission,
    scenarioResult.fireplaceEmission,
    scenarioResult.replacementEmission
  ];
  if (scenario.scope === 'domestic') {
    values.push(remainderAdjusted, domesticExtras.totalDomestic, domesticExtras.gas, domesticExtras.other);
  }
  return values;
}

function computeUnitScale(unit, values) {
  const UNIT_SCALE_STEPS = {
    'kt-co2-equivalent': { next: 't-co2-equivalent', factor: 1000 },
    kilotonne: { next: 'tonne', factor: 1000 },
    tonne: { next: 'kg', factor: 1000 },
    kg: { next: 'g', factor: 1000 },
    g: { next: 'mg', factor: 1000 },
    mg: { next: 'µg', factor: 1000 },
    'g-i-teq': { next: 'mg-i-teq', factor: 1000 },
    'mg-i-teq': { next: 'µg-i-teq', factor: 1000 }
  };

  let maxValue = 0;
  (values || []).forEach(value => {
    const num = Math.abs(Number(value));
    if (Number.isFinite(num)) {
      maxValue = Math.max(maxValue, num);
    }
  });
  const baseLabel = getPluralUnitLabel(unit);
  const baseShort = getUnitAbbreviation(unit);
  let unitKey = getUnitKey(unit);
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { factor: 1, unitKey, unitLabel: baseLabel, unitShort: baseShort };
  }
  let factor = 1;
  let scaledMax = maxValue;
  let safety = 0;
  while (scaledMax < 0.01 && UNIT_SCALE_STEPS[unitKey] && safety < 6) {
    const step = UNIT_SCALE_STEPS[unitKey];
    factor *= step.factor;
    unitKey = step.next;
    scaledMax = maxValue * factor;
    safety += 1;
  }
  return {
    factor,
    unitKey,
    unitLabel: unitKey,
    unitShort: baseShort || unitKey || baseLabel
  };
}

function parseTooltip(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }
  const map = {};
  rows.forEach(row => {
    const label = (row.label || '').toLowerCase();
    const values = Array.isArray(row.values) ? row.values.map(parseNumber) : [];
    if (label.startsWith('other fireplaces')) {
      map.remainder = values[0];
    } else if (label.endsWith('(replaced)')) {
      map.fireplace = values[0];
    } else if (label.toLowerCase().indexOf('ecodesign') !== -1) {
      map.eco = values[0];
      map.replacement = values[1];
    } else if (label === 'other') {
      map.other = values[0];
    } else if (label === 'gas boilers') {
      map.gas = values[0];
    } else if (label === 'total') {
      map.totalCurrent = values[0];
      map.totalReplacement = values[1];
    }
  });
  return map;
}

function createTimeseriesIndex(rows = []) {
  const index = new Map();
  rows.forEach(row => {
    const pollutantId = Number(row?.pollutant_id ?? row?.pollutantId);
    const categoryId = Number(row?.category_id ?? row?.categoryId);
    if (!Number.isFinite(pollutantId) || !Number.isFinite(categoryId)) {
      return;
    }
    index.set(`${pollutantId}|${categoryId}`, row);
  });
  return index;
}

function resolveYearKey(year) {
  if (typeof year === 'string') {
    if (year.startsWith('f')) return year;
    if (/^\d{4}$/.test(year)) return `f${year}`;
  }
  const numeric = Number(year);
  return Number.isFinite(numeric) ? `f${numeric}` : null;
}

function getTimeseriesValue(index, pollutantId, categoryId, year) {
  if (!index || !Number.isFinite(Number(pollutantId)) || !Number.isFinite(Number(categoryId))) {
    return NaN;
  }
  const key = `${Number(pollutantId)}|${Number(categoryId)}`;
  const row = index.get(key);
  if (!row) return NaN;
  const yearKey = resolveYearKey(year);
  if (!yearKey) return NaN;
  return normalizeNumber(row[yearKey]);
}

function normalizeNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return NaN;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  if (value == null) return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function sumActivityValues(...values) {
  return values.reduce((total, value) => {
    const numericValue = normalizeNumber(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return total;
    }
    return total + numericValue;
  }, 0);
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

function getUnitAbbreviation(unit) {
  return String(unit || '').trim();
}

function getPluralUnitLabel(unit) {
  const trimmed = String(unit || '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  const invariantUnits = ['kg', 'g', 'mg', 'µg', 'ug', 'kt', 't', 'tj', 'gj', 'mj', 'kwh', 'mwh', 'gwh'];
  if (invariantUnits.includes(lower)) return trimmed;
  if (lower.endsWith('s')) return trimmed;
  if (lower.endsWith('y') && lower.length > 1) {
    const penultimate = lower.charAt(lower.length - 2);
    if (!'aeiou'.includes(penultimate)) {
      return trimmed.slice(0, -1) + 'ies';
    }
  }
  return trimmed + 's';
}

function getUnitKey(unit) {
  return String(unit || '').trim().toLowerCase();
}

function parseNumber(text) {
  if (!text) return NaN;
  const normalized = text
    .replace(/[^0-9+\-.,∞]/g, '')
    .replace(/,/g, '')
    .replace('−', '-');
  if (!normalized || normalized === '∞' || normalized === '+∞') {
    return Infinity;
  }
  if (normalized === '-∞') {
    return -Infinity;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parsePercent(text) {
  if (!text) return NaN;
  const normalized = text.replace(/%/g, '').trim();
  if (normalized.includes('∞')) {
    return normalized.startsWith('-') ? -Infinity : Infinity;
  }
  return parseNumber(normalized);
}

function withinTolerance(expected, actual, tolerance = 1e-6) {
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  if (expected === 0) return Math.abs(actual) <= tolerance;
  return Math.abs(expected - actual) <= Math.abs(expected) * 1e-6 + tolerance;
}

function coerceNonNegative(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return NaN;
  return Math.max(0, num);
}

function isCarbonDioxideAsCarbon(pollutant) {
  if (!pollutant) return false;
  if (Number.isFinite(EXCLUDED_POLLUTANT_ID) && Number(pollutant.id) === Number(EXCLUDED_POLLUTANT_ID)) {
    return true;
  }
  return normalizePollutantLabel(pollutant.pollutant) === normalizePollutantLabel(EXCLUDED_POLLUTANT_NAME)
    || normalizePollutantLabel(pollutant.pollutant) === normalizePollutantLabel(EXCLUDED_POLLUTANT_TAG);
}

function normalizePollutantLabel(label) {
  return String(label || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  return Number(value).toPrecision(6);
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
  const logPath = path.join(outDir, `eco-calculation-checks-${Date.now()}.json`);
  await writeFile(logPath, JSON.stringify(payload, null, 2));
  console.log(`Eco calculation results written to ${path.relative(projectRoot, logPath)}`);
}

function printSummary(results, baseUrl, pagePath) {
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  console.log(`\nEco calculation audit completed against ${baseUrl}${pagePath}`);
  console.log(`   Passed : ${passed}`);
  console.log(`   Failed : ${failed}`);
  console.log(`   Skipped: ${skipped}`);
  if (failed) {
    console.log('\nFailures:');
    results.filter(r => r.status === 'failed').forEach(r => {
      const label = `${r.scenario.scope} · ${r.scenario.year} · ${r.scenario.pollutantName} · ${r.scenario.fireplaceName}`;
      console.log(` - ${label}`);
      (r.mismatches || []).forEach(msg => console.log(`    • ${msg}`));
    });
  }
}
