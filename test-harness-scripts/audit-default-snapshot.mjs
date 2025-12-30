#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_SNAPSHOT_PATH = path.join(projectRoot, 'SharedResources', 'default-chart-data.json');
const DEFAULT_OUT_DIR = path.join(projectRoot, 'test-results', 'snapshot-audit');
const MIN_ECO_YEAR = 2017;
const ECO_READY_CATEGORY_ID = 20;
const FIREPLACE_PATTERN = /(fireplace|stove|chiminea|burner|grate|open fire|log burner)/i;
const EXCLUDED_FIREPLACE_CATEGORY_IDS = new Set([20, 65]);
const FIREPLACES_ALL_CATEGORY_ID = 27;
const DOMESTIC_COMBUSTION_CATEGORY_ID = 13;
const GAS_BOILERS_CATEGORY_ID = 37;

await main().catch(error => {
  console.error('\nSnapshot audit failed:', error);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotPath = path.resolve(projectRoot, args.snapshot || DEFAULT_SNAPSHOT_PATH);
  const dataset = await loadDataset(snapshotPath);
  const checks = runChecks(dataset);
  await saveResults(args.outDir || DEFAULT_OUT_DIR, snapshotPath, checks);
  printSummary(snapshotPath, checks);
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

async function loadDataset(snapshotPath) {
  try {
    const raw = await readFile(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeDataset(parsed, snapshotPath);
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? `Snapshot not found at ${snapshotPath}` : error.message || error;
    throw new Error(`Unable to load dataset: ${reason}`);
  }
}

function normalizeDataset(snapshot, snapshotPath) {
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
  const years = extractYearList(timeseries);
  const activityPollutant = pollutants.find(p => (p.pollutant || '').trim().toLowerCase() === 'activity data');
  const pm25Pollutant = pollutants.find(p => (p.pollutant || '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'pm25');
  return {
    snapshotPath,
    pollutants,
    pollutantById,
    categories,
    categoryById,
    timeseries,
    timeseriesIndex,
    years,
    activityPollutant,
    pm25Pollutant
  };
}

function runChecks(dataset) {
  const latestYear = Math.max(...dataset.years.filter(Number.isFinite));
  const checks = [];

  checks.push(makeCheck('Activity pollutant present', !!dataset.activityPollutant, dataset.activityPollutant ? `Found id ${dataset.activityPollutant.id}` : 'Missing Activity Data pollutant'));
  const ecoCategory = dataset.categoryById.get(ECO_READY_CATEGORY_ID) || dataset.categories.find(cat => /ecodesign.+ready.+burn/i.test(String(cat?.category_title || cat?.group_name || '').toLowerCase()));
  checks.push(makeCheck('Eco Ready category present', !!ecoCategory, ecoCategory ? `Found id ${ecoCategory.id}` : 'Missing Ecodesign category'));

  const fireplaceOptions = (dataset.categories || []).filter(cat => {
    const title = cat?.category_title || cat?.group_name || '';
    if (!FIREPLACE_PATTERN.test(String(title))) return false;
    return !EXCLUDED_FIREPLACE_CATEGORY_IDS.has(Number(cat.id));
  });
  checks.push(makeCheck('Fireplace/stove options available', fireplaceOptions.length > 0, fireplaceOptions.length ? `${fireplaceOptions.length} options` : 'No fireplace categories matched'));

  const hasRecentYear = dataset.years.some(y => y >= MIN_ECO_YEAR);
  checks.push(makeCheck(`Years include ${MIN_ECO_YEAR} or newer`, hasRecentYear, hasRecentYear ? `Years: ${dataset.years.join(', ')}` : 'No recent years in timeseries'));

  const activityEco = getTimeseriesValue(dataset.timeseriesIndex, dataset.activityPollutant?.id, ECO_READY_CATEGORY_ID, latestYear);
  const activityFireplaces = getTimeseriesValue(dataset.timeseriesIndex, dataset.activityPollutant?.id, FIREPLACES_ALL_CATEGORY_ID, latestYear);
  const activityDomestic = getTimeseriesValue(dataset.timeseriesIndex, dataset.activityPollutant?.id, DOMESTIC_COMBUSTION_CATEGORY_ID, latestYear);
  const activityHasData = [activityEco, activityFireplaces, activityDomestic].some(Number.isFinite);
  checks.push(makeCheck(`Activity data available for latest year ${latestYear}`, activityHasData, activityHasData ? 'Activity values present' : 'Missing activity values for key categories'));

  const pmEco = dataset.pm25Pollutant ? getTimeseriesValue(dataset.timeseriesIndex, dataset.pm25Pollutant.id, ECO_READY_CATEGORY_ID, latestYear) : NaN;
  const pmFireplace = dataset.pm25Pollutant ? getTimeseriesValue(dataset.timeseriesIndex, dataset.pm25Pollutant.id, FIREPLACES_ALL_CATEGORY_ID, latestYear) : NaN;
  const pmDomestic = dataset.pm25Pollutant ? getTimeseriesValue(dataset.timeseriesIndex, dataset.pm25Pollutant.id, DOMESTIC_COMBUSTION_CATEGORY_ID, latestYear) : NaN;
  const pmHasData = [pmEco, pmFireplace, pmDomestic].some(Number.isFinite);
  checks.push(makeCheck('PM2.5 coverage for latest year', pmHasData, pmHasData ? 'PM2.5 values present for eco/fireplace/domestic' : 'PM2.5 values missing for key categories'));

  const missingUnits = (dataset.pollutants || []).filter(p => !p?.emission_unit).length;
  checks.push(makeCheck('Pollutant units populated', missingUnits === 0, missingUnits === 0 ? 'All pollutants include units' : `${missingUnits} pollutants missing units`));

  const gasCoverage = getTimeseriesValue(dataset.timeseriesIndex, dataset.pm25Pollutant?.id, GAS_BOILERS_CATEGORY_ID, latestYear);
  checks.push(makeCheck('Gas boiler baseline available', Number.isFinite(gasCoverage), Number.isFinite(gasCoverage) ? 'Gas boiler values present' : 'Missing gas boiler values for latest year'));

  return checks;
}

function makeCheck(name, condition, detail) {
  return {
    name,
    status: condition ? 'passed' : 'failed',
    detail: detail || ''
  };
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

function createTimeseriesIndex(rows = []) {
  const index = new Map();
  rows.forEach(row => {
    const pollutantId = Number(row?.pollutant_id ?? row?.pollutantId);
    const categoryId = Number(row?.category_id ?? row?.categoryId);
    if (!Number.isFinite(pollutantId) || !Number.isFinite(categoryId)) return;
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
  if (!index || !Number.isFinite(Number(pollutantId)) || !Number.isFinite(Number(categoryId))) return NaN;
  const key = `${Number(pollutantId)}|${Number(categoryId)}`;
  const row = index.get(key);
  if (!row) return NaN;
  const yearKey = resolveYearKey(year);
  if (!yearKey) return NaN;
  const value = row[yearKey];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

async function saveResults(outDir, snapshotPath, checks) {
  const totals = {
    passed: checks.filter(c => c.status === 'passed').length,
    failed: checks.filter(c => c.status === 'failed').length,
    total: checks.length
  };
  const payload = {
    generatedAt: new Date().toISOString(),
    snapshotPath,
    totals,
    checks
  };
  const targetDir = path.resolve(projectRoot, outDir);
  await mkdir(targetDir, { recursive: true });
  const outPath = path.join(targetDir, `snapshot-audit-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`Snapshot audit written to ${path.relative(projectRoot, outPath)}`);
}

function printSummary(snapshotPath, checks) {
  console.log(`\nSnapshot audit for ${snapshotPath}`);
  checks.forEach(check => {
    const mark = check.status === 'passed' ? '✓' : '✗';
    console.log(` ${mark} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  });
  const failed = checks.filter(c => c.status === 'failed').length;
  if (failed) {
    console.log(`\n${failed} issue(s) detected. See details above.`);
  }
}
