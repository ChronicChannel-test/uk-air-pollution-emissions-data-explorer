#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const config = loadConfig();

if (!config.supabaseUrl || !config.supabaseKey) {
  console.error('Supabase credentials missing. Update config/config.local.json.');
  process.exit(1);
}

const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const pollInterval = Number(config.pollIntervalMs || 5000);
const batchLimit = Number(config.eventLimit || 25);
const state = {
  eventsCursor: null,
  errorsCursor: null
};

console.log('📡 Tailing site_events and site_errors');
console.log(`   Supabase: ${config.supabaseUrl}`);
console.log('   Press Ctrl+C to exit.\n');

async function startPolling() {
  try {
    await Promise.all([
      pollTable('site_events', 'eventsCursor', formatEventRow),
      pollTable('site_errors', 'errorsCursor', formatErrorRow)
    ]);
  } catch (error) {
    console.error('Polling failed:', error.message || error);
  } finally {
    setTimeout(startPolling, pollInterval);
  }
}

async function pollTable(tableName, cursorKey, formatter) {
  let query = supabase
    .from(tableName)
    .select('*')
    .order('recorded_at', { ascending: true })
    .limit(batchLimit);

  if (state[cursorKey]) {
    query = query.gt('recorded_at', state[cursorKey]);
  }

  const { data, error } = await query;
  if (error) {
    console.error(`[${tableName}] query error:`, error.message || error);
    return;
  }

  (data || []).forEach(row => {
    state[cursorKey] = row.recorded_at;
    console.log(formatter(row));
  });
}

function formatEventRow(row) {
  const payload = compactJson(row.event_data);
  return `[site_events] ${row.recorded_at} ${row.event_type}/${row.event_label || '—'} ${row.page_slug} :: ${payload}`;
}

function formatErrorRow(row) {
  const details = compactJson(row.details);
  return `[site_errors] ${row.recorded_at} ${row.severity} ${row.source || 'unknown'} :: ${row.message} :: ${details}`;
}

function compactJson(value) {
  if (!value) {
    return '{}';
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return '[unserializable payload]';
  }
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

startPolling();
