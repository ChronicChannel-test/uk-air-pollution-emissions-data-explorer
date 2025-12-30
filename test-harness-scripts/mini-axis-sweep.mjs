#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const presets = [
  { name: 'auto', qs: '' },
  { name: 'auto-no-minor', qs: 'minor=none' },
  { name: 'grid4', qs: 'gridlines=4' },
  { name: 'grid4-no-minor', qs: 'gridlines=4&minor=none' },
  { name: 'chartLeft56', qs: 'chartLeft=56' },
  { name: 'chartLeft64', qs: 'chartLeft=64' },
  { name: 'explicit', qs: 'axisVariant=explicit' }
];

const baseUrl = process.env.SWEEP_BASE_URL || 'http://localhost:4100/app/EcoReplacesAll/embed.html';
const mode = 'embed';
const limit = process.env.SWEEP_LIMIT || '6';
const autostart = process.env.SWEEP_AUTOSTART || 'false';
const rerender = process.env.SWEEP_RERENDER || 'false';

function runPreset(preset) {
  const url = preset.qs ? `${baseUrl}?${preset.qs}` : baseUrl;
  const outDir = path.join('test-results', 'axis-sweep', preset.name);
  const args = [
    path.join(__dirname, 'check-mini-axis.mjs'),
    `--mode=${mode}`,
    `--url=${url}`,
    `--limit=${limit}`,
    `--autostart=${autostart}`,
    `--rerender=${rerender}`,
    `--outDir=${outDir}`
  ];

  console.log(`\n▶️  Preset: ${preset.name}`);
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: 'inherit'
  });
  if (result.status) {
    console.warn(`Preset ${preset.name} failed with code ${result.status}`);
  }
}

presets.forEach(runPreset);
