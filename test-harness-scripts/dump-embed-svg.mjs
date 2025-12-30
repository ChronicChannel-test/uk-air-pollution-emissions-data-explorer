#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const url = args.url || 'http://localhost:4100/app/EcoReplacesAll/embed.html';
const selector = args.selector || '.eco-google-chart';
const limit = Number(args.limit) || 3;
const outDir = args.outDir || 'test-results/embed-axis';
const baseName = args.basename || 'embed-chart';
const viewportWidth = Number(args.width) || 1500;
const viewportHeight = Number(args.height) || 980;

async function main() {
  const outPath = path.resolve(process.cwd(), outDir);
  await mkdir(outPath, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight } });

  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector(selector, { timeout: 20000 });

  const svgs = await page.evaluate(({ selector, limit }) => {
    const hosts = Array.from(document.querySelectorAll(selector)).slice(0, limit);
    return hosts.map((host, idx) => {
      const svg = host.querySelector('svg');
      const title = host.closest('.eco-chart-card')?.querySelector('.eco-card-title')?.textContent?.trim() || null;
      const unit = host.closest('.eco-chart-card')?.querySelector('.eco-card-unit')?.textContent?.trim() || null;
      return {
        index: idx + 1,
        title,
        unit,
        hasSvg: !!svg,
        svgOuterHTML: svg ? svg.outerHTML : null
      };
    });
  }, { selector, limit });

  const summary = [];
  for (const entry of svgs) {
    summary.push({ index: entry.index, title: entry.title, unit: entry.unit, hasSvg: entry.hasSvg });
    if (entry.svgOuterHTML) {
      const filePath = path.join(outPath, `${baseName}-${entry.index}.svg`);
      await writeFile(filePath, entry.svgOuterHTML, 'utf8');
      console.log(`Wrote ${filePath}`);
    }
  }

  await writeFile(path.join(outPath, `${baseName}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(`Summary written to ${path.join(outPath, `${baseName}-summary.json`)}`);

  await browser.close();
}

main().catch(err => {
  console.error('Dump embed SVG failed:', err);
  process.exitCode = 1;
});
