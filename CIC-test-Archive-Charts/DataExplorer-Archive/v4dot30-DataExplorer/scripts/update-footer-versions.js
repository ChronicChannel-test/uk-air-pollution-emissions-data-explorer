#!/usr/bin/env node
/**
 * Updates "Explorer Version" footer lines using version files.
 * Automatically targets staged HTML files outside CIC-test-Archive-Charts.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

const VERSION_SOURCES = {
  explorer: 'dataexplorer-version.txt',
  bubble: path.join('bubblechart', 'bubblechart-version.txt'),
  line: path.join('linechart', 'linechart-version.txt')
};

function readVersion(relativePath, label) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing ${label} file at ${relativePath}`);
  }
  const value = fs.readFileSync(fullPath, 'utf8').trim();
  if (!value) {
    throw new Error(`${label} file ${relativePath} is empty`);
  }
  return value.replace(/\s+/g, ' ').trim();
}

function formatBuildDate(date = new Date()) {
  const pad = (num) => String(num).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}.${month}.${day}`;
}

function getStagedFiles() {
  const output = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
  if (!output) {
    return [];
  }
  return output.split(/\r?\n/).filter(Boolean);
}

function quotePath(value) {
  const escaped = value.replace(/(["\\$`])/g, '\\$1');
  return `"${escaped}"`;
}

function updateFooterLine(line, explorerVersion, lineVersion, bubbleVersion, buildDate) {
  if (!line.includes('Explorer Version:')) {
    return line;
  }

  const explorerPattern = /Explorer Version:[^<\n]*/;
  const buildPattern = /•\s*Build:[^<\n]*/;
  const updatedVersionSegment = `Explorer Version: ${explorerVersion} (Line: ${lineVersion}, Bubble: ${bubbleVersion})`;
  let updatedLine = line.replace(explorerPattern, updatedVersionSegment);
  if (buildPattern.test(updatedLine)) {
    updatedLine = updatedLine.replace(buildPattern, `• Build: ${buildDate}`);
  }
  return updatedLine;
}

function main() {
  const stagedFiles = getStagedFiles();
  if (!stagedFiles.length) {
    return;
  }

  const explorerVersion = readVersion(VERSION_SOURCES.explorer, 'explorer');
  const bubbleVersion = readVersion(VERSION_SOURCES.bubble, 'bubble chart');
  const lineVersion = readVersion(VERSION_SOURCES.line, 'line chart');
  const buildDate = formatBuildDate();

  const htmlFiles = stagedFiles
    .filter((relativePath) => !relativePath.startsWith('CIC-test-Archive-Charts/'))
    .filter((relativePath) => path.extname(relativePath).toLowerCase() === '.html');
  
  const defaultTargets = ['index.html'];
  defaultTargets.forEach((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    if (fs.existsSync(absolutePath) && !htmlFiles.includes(relativePath)) {
      htmlFiles.push(relativePath);
    }
  });
  if (!htmlFiles.length) {
    return;
  }

  let updatedCount = 0;

  htmlFiles.forEach((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const original = fs.readFileSync(absolutePath, 'utf8');
    const lines = original.split('\n');
    let fileUpdated = false;

    const nextLines = lines.map((line) => {
      if (!line.includes('Explorer Version:')) {
        return line;
      }
      const freshLine = updateFooterLine(line, explorerVersion, lineVersion, bubbleVersion, buildDate);
      if (freshLine !== line) {
        fileUpdated = true;
      }
      return freshLine;
    });

    if (fileUpdated) {
      fs.writeFileSync(absolutePath, nextLines.join('\n'), 'utf8');
      execSync(`git add ${quotePath(relativePath)}`);
      updatedCount += 1;
    }
  });

  if (updatedCount) {
    console.log(`Updated footer version info in ${updatedCount} file(s).`);
  }
}

try {
  main();
} catch (error) {
  console.error('Failed to update version footer:', error.message);
  process.exit(1);
}
