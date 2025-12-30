import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';
import { resolve } from 'path';

function parseArgs(argv) {
  return argv.reduce((acc, arg) => {
    if (!arg.startsWith('--')) return acc;
    const [key, raw] = arg.slice(2).split('=');
    acc[key] = raw ?? 'true';
    return acc;
  }, {});
}

const args = parseArgs(process.argv.slice(2));
const url = args.url || 'http://localhost:4100/app/EcoReplacesAll/mini-chart-debug.html';
const variants = (args.variants || Array(8).fill('native-overlay').join(','))
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);
const outDir = args.outDir || 'test-results/mini-debug';
const fileName = args.file || `mini-debug-${Date.now()}.png`;
const viewportWidth = Number(args.width) || 1500;
const viewportHeight = Number(args.height) || 980;

async function main() {
  const screenshotPath = resolve(process.cwd(), outDir, fileName);
  await mkdir(resolve(process.cwd(), outDir), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight } });

  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#embedChartHost5', { timeout: 20000 });

  // Re-render embeds with the provided variant list so we can quickly try alternatives without editing HTML.
  await page.evaluate(({ variants }) => {
    const tiles = [
      { shellId: 'embedTile1', chartId: 'embedChartHost1' },
      { shellId: 'embedTile2', chartId: 'embedChartHost2' },
      { shellId: 'embedTile3', chartId: 'embedChartHost3' },
      { shellId: 'embedTile4', chartId: 'embedChartHost4' },
      { shellId: 'embedTile5', chartId: 'embedChartHost5' },
      { shellId: 'embedTile6', chartId: 'embedChartHost6' },
      { shellId: 'embedTile7', chartId: 'embedChartHost7' },
      { shellId: 'embedTile8', chartId: 'embedChartHost8' },
    ];

    tiles.forEach((tile, idx) => {
      const host = document.getElementById(tile.chartId);
      const variant = variants[idx] || variants[variants.length - 1] || 'overlay-strict';
      if (!host || typeof buildEmbedChart !== 'function') return;
      host.innerHTML = '';
      buildEmbedChart(SAMPLE, tile.chartId, variant);
      const title = document.querySelector(`#${tile.shellId} h2`);
      if (title && title.firstChild) {
        title.firstChild.textContent = `Embed renderer ${idx + 1} (${variant}) `;
      }
    });
  }, { variants });

  await page.waitForTimeout(600);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();
  console.log(`Saved screenshot to ${screenshotPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
