import express from 'express';
import morgan from 'morgan';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const config = loadConfig();

const app = express();
app.use(morgan('dev'));

const publicDir = path.join(projectRoot, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.get('/harness-config.json', (req, res) => {
  res.json({
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseKey,
    pollIntervalMs: config.pollIntervalMs,
    eventLimit: config.eventLimit
  });
});

const explorerRoot = resolveExplorerRoot();
if (explorerRoot) {
  app.use('/app', express.static(explorerRoot, { extensions: ['html'] }));
  console.log(`📦 Serving data explorer from: ${explorerRoot}`);
} else {
  console.warn('⚠️  dataExplorerRoot not found. Update config/config.local.json to point at your repo.');
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

const port = Number(config.port || process.env.PORT || 4100);
app.listen(port, () => {
  console.log(`🚀 Harness server running at http://localhost:${port}`);
  console.log('   • Explorer: http://localhost:%d/app/', port);
  console.log('   • Monitor : http://localhost:%d/monitor', port);
});

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

function resolveExplorerRoot() {
  const candidate = config.dataExplorerRoot
    ? path.resolve(projectRoot, config.dataExplorerRoot)
    : null;
  if (candidate && fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}
