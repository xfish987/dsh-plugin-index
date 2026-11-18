#!/usr/bin/env node
/** validate-index.mjs — validate dist/index.json (or a given file) against format 1. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const file = path.resolve(ROOT, process.argv[2] ?? 'dist/index.json');
const text = await fs.readFile(file, 'utf8');
const value = JSON.parse(text);

try {
  const index = parseMarketIndex(value, process.env.INDEX_URL ?? 'https://dsh-plugin-index.example/index.json');
  const versions = index.plugins.reduce((total, plugin) => total + plugin.versions.length, 0);
  console.log(`OK ${file}`);
  console.log(`  format ${index.format} · ${index.plugins.length} plugins · ${versions} versions · ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  title: ${JSON.stringify(index.title)}`);
  const newest = index.plugins
    .flatMap((plugin) => plugin.versions.map((version) => version.publishTimestamp))
    .reduce((max, timestamp) => Math.max(max, timestamp), 0);
  console.log(`  newest publish: ${new Date(newest * 1000).toISOString()}`);
} catch (error) {
  console.error(`INVALID: ${error.path ?? ''} ${error.message}`);
  process.exitCode = 1;
}
