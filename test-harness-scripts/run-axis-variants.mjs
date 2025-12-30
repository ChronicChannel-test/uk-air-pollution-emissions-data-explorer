#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const checker = path.join(__dirname, 'check-mini-axis.mjs');

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
const harnessBase = args.base || process.env.HARNESS_BASE_URL || 'http://localhost:4100';
const urlPath = args.path || '/app/EcoReplacesAll/embed.html';
const variants = (args.variants || 'native-auto,native-explicit')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);
const limit = args.limit || '6';
const rerender = args.rerender || 'false';
const autostart = args.autostart || 'false';
const outDir = args.outDir || 'test-results/axis-variants';

async function runVariant(variant) {
  const url = `${harnessBase}${urlPath}?axisVariant=${encodeURIComponent(variant)}`;
  const stamp = Date.now();
  const runOutDir = path.join(outDir, variant);
  const logName = `axis-log-${variant}-${stamp}.json`;
  const screenshot = `mini-axis-${variant}-${stamp}.png`;
  const cmd = process.execPath;
  const cmdArgs = [checker,
    '--mode=embed',
    `--url=${url}`,
    `--outDir=${runOutDir}`,
    `--limit=${limit}`,
    `--rerender=${rerender}`,
    `--autostart=${autostart}`,
    `--log=${logName}`,
    `--screenshot=${screenshot}`
  ];
  console.log(`\n▶ Running ${variant}: ${url}`);
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    child.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Variant ${variant} exited with code ${code}`));
      }
    });
  });
}

(async function main() {
  for (const variant of variants) {
    await runVariant(variant);
  }
})().catch(err => {
  console.error('Axis variant runner failed:', err.message);
  process.exitCode = 1;
});
