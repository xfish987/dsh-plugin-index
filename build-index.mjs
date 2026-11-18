#!/usr/bin/env node
/**
 * build-index.mjs — generate a DSH plugin market index (format 1) from the public npm registry.
 *
 * Pipeline:
 *   1. discover package names: public seeds (existing indexes) + npm keyword search slices
 *   2. fetch each package's packument (cached under .cache/packuments)
 *   3. keep packages that declare `dsh.bundle` in at least one published version
 *   4. derive `engines.dsh` per version: declared engines first, otherwise the intersection of
 *      the `@deepseek-ai/dsh*` peer ranges
 *   5. validate the result with the official format-1 validator, then write dist/index.json
 *
 * Flags: --no-cache  --no-downloads  --limit <n>  --out <file>
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REGISTRY = 'https://registry.npmjs.org';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const CONFIG = {
  outFile: path.resolve(ROOT, option('--out', 'dist/index.json')),
  cacheDir: path.resolve(ROOT, '.cache'),
  indexUrl: process.env.INDEX_URL ?? 'https://dsh-plugin-index.example/index.json',
  title: { en: 'DSH Plugin Index (self-hosted)', zh: 'DSH 插件索引（自建）' },
  description: {
    en: 'Every installable DSH bundle on npm, rebuilt from npm metadata and the public indexes.',
    zh: 'npm 上可安装的 DSH 组合包，由 npm 元数据与公开索引重建。',
  },
  concurrency: 24,
  downloadConcurrency: 16,
  requestTimeoutMs: 30_000,
  retries: 4,
  packumentTtlMs: Number(option('--packument-ttl', String(6 * 60 * 60 * 1000))),
  seedTtlMs: 6 * 60 * 60 * 1000,
  maxVersionsPerPlugin: Number(option('--max-versions', '12')),
  searchPages: Number(option('--search-pages', '21')),
  searchRecentDays: Number(option('--recent-days', '90')),
  seedUrls: [
    // Frozen (unmaintained since 2026-11-06) but still a useful name directory.
    'https://realoiyo.github.io/dsh-plugin-market/index.json',
    // Maintained curated catalog; also a format-1 index.
    'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json',
  ],
  useDownloads: !flag('--no-downloads'),
  useCache: !flag('--no-cache'),
  limit: Number(option('--limit', '0')),
  labels: {
    'downloads-1000': { en: '↓ 1k/wk', zh: '↓ 1k/wk' },
    'downloads-5000': { en: '↓ 5k/wk', zh: '↓ 5k/wk' },
    'downloads-10000': { en: '↓ 10k/wk', zh: '↓ 10k/wk' },
    'downloads-50000': { en: '↓ 50k/wk', zh: '↓ 50k/wk' },
    'downloads-100000': { en: '↓ 100k/wk', zh: '↓ 100k/wk' },
  },
};

const started = Date.now();
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ HTTP */

async function fetchWithRetry(url, { retries = CONFIG.retries, timeoutMs = CONFIG.requestTimeoutMs, headers = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'dsh-plugin-index/0.1 (+https://github.com/)', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return { status: 404, body: null };
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        await sleep(Math.min(8_000, 500 * 2 ** attempt));
        continue;
      }
      if (!response.ok) return { status: response.status, body: null };
      return { status: response.status, body: await response.text() };
    } catch (error) {
      lastError = error;
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
    }
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}

async function pool(items, worker, concurrency, onProgress) {
  const queue = [...items];
  let done = 0;
  const runner = async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
      done += 1;
      if (onProgress && done % 500 === 0) onProgress(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, runner));
}

const packumentUrl = (name) => `${REGISTRY}/${name.startsWith('@') ? name.replace('/', '%2F') : name}`;

/* -------------------------------------------------------------- discovery */

async function loadSeeds() {
  const names = new Set();
  for (const url of CONFIG.seedUrls) {
    const cacheFile = path.join(CONFIG.cacheDir, 'seeds', `${Buffer.from(url).toString('base64url')}.json`);
    try {
      const stats = existsSync(cacheFile) ? await fs.stat(cacheFile) : null;
      let body;
      if (CONFIG.useCache && stats && Date.now() - stats.mtimeMs < CONFIG.seedTtlMs) {
        body = await fs.readFile(cacheFile, 'utf8');
      } else {
        const result = await fetchWithRetry(url, { timeoutMs: 60_000 });
        if (!result.body) throw new Error(`seed returned ${result.status}`);
        body = result.body;
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, body);
      }
      const parsed = JSON.parse(body);
      let count = 0;
      for (const plugin of parsed.plugins ?? []) {
        if (typeof plugin?.name === 'string') { names.add(plugin.name); count += 1; }
      }
      log(`seed ${url} -> ${count} names`);
    } catch (error) {
      log(`seed failed (ignored) ${url}: ${error.message}`);
    }
  }
  return names;
}

async function searchSlice(text, pages) {
  const names = new Set();
  for (let page = 0; page < pages; page++) {
    const from = page * 250;
    const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=250&from=${from}`;
    let payload;
    try {
      const result = await fetchWithRetry(url, { timeoutMs: 20_000 });
      payload = result.body ? JSON.parse(result.body) : null;
    } catch (error) {
      log(`search page ${page} of "${text}" failed: ${error.message}`);
      break;
    }
    if (!payload?.objects?.length) break;
    let added = 0;
    for (const object of payload.objects) {
      const name = object?.package?.name;
      if (typeof name === 'string' && !names.has(name)) { names.add(name); added += 1; }
    }
    if (added === 0) break; // the API wraps around past ~5250 results
  }
  log(`search "${text}" -> ${names.size} names`);
  return names;
}

async function discover() {
  const names = await loadSeeds();

  // Self-seed from the previous build, so a name never drops out because of search paging.
  const previous = path.resolve(ROOT, 'dist/index.json');
  if (existsSync(previous)) {
    try {
      const parsed = JSON.parse(await fs.readFile(previous, 'utf8'));
      let count = 0;
      for (const plugin of parsed.plugins ?? []) {
        if (typeof plugin?.name === 'string' && !names.has(plugin.name)) { names.add(plugin.name); count += 1; }
      }
      log(`previous build -> ${count} extra names`);
    } catch { /* ignore a corrupt previous build */ }
  }

  const since = new Date(Date.now() - CONFIG.searchRecentDays * 86_400_000).toISOString().slice(0, 10);
  for (const text of ['keywords:dsh-plugin', `keywords:dsh-plugin published:>${since}`, 'keywords:dsh-bundle']) {
    for (const name of await searchSlice(text, CONFIG.searchPages)) names.add(name);
  }
  return [...names].sort();
}

/* --------------------------------------------------------------- packument */

const cacheName = (name) => path.join(CONFIG.cacheDir, 'packuments', `${name.replace(/[/@]/g, '_')}.json`);

const DSH_PEER = /^@deepseek-ai\/dsh(?:-|$)/;
/** Exactly the npm-name rule the format-1 validator enforces; one illegal name would reject the whole index. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const isIndexableName = (name) => typeof name === 'string' && name.length <= 214 && PACKAGE_NAME.test(name);

function peerRanges(data) {
  const ranges = [];
  for (const [peer, range] of Object.entries(data.peerDependencies ?? {})) {
    if (DSH_PEER.test(peer) && typeof range === 'string' && range !== '*' && !range.startsWith('workspace:')) ranges.push(range);
  }
  return ranges;
}

/** Intersection of SemVer ranges, expressed as a range string; `undefined` when it cannot be represented compactly. */
function intersectRanges(ranges) {
  const unique = [...new Set(ranges.filter((range) => typeof range === 'string' && semver.validRange(range)))];
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  try {
    const sets = unique.map((range) => new semver.Range(range).set);
    const candidates = [];
    const walk = (index, accumulated) => {
      if (index === sets.length) {
        const comparators = [...new Set(accumulated.filter(Boolean))].join(' ');
        candidates.push(comparators === '' ? '*' : comparators);
        return;
      }
      for (const comparatorSet of sets[index]) {
        walk(index + 1, [...accumulated, ...comparatorSet.map((comparator) => comparator.value)]);
      }
    };
    walk(0, []);
    const satisfiable = candidates.filter((candidate) => {
      try { return semver.minVersion(candidate) !== null; } catch { return false; }
    });
    if (satisfiable.length === 0) return undefined;
    const text = satisfiable.length === 1 ? satisfiable[0] : satisfiable.join(' || ');
    return text.length <= 160 ? text : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRepository(repository) {
  if (!repository) return undefined;
  let url = typeof repository === 'string' ? repository : repository.url;
  if (typeof url !== 'string' || url.trim() === '') return undefined;
  url = url.trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/');
  let parsed;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  parsed.search = '';
  parsed.hash = '';
  let pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (pathname.split('/').filter(Boolean).length < 2) return undefined;
  const result = { url: `${parsed.origin}${pathname}` };
  const directory = typeof repository === 'object' ? repository.directory : undefined;
  const SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
  if (typeof directory === 'string' && directory !== '') {
    const segments = directory.replace(/^\.?\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
    // The format only allows letters, digits, and ._@+- in a relative directory; drop anything odder.
    if (segments.length > 0 && segments.every((segment) => segment !== '.' && segment !== '..' && SEGMENT.test(segment))) {
      result.directory = segments.join('/');
    }
  }
  return result;
}

function normalizeHomepage(homepage) {
  if (typeof homepage !== 'string' || !URL.canParse(homepage)) return undefined;
  const url = new URL(homepage);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return url.href;
}

function authorName(author) {
  if (typeof author === 'string') return author.trim() || undefined;
  if (author && typeof author.name === 'string') return author.name.trim() || undefined;
  return undefined;
}

function extract(name, packument) {
  const versions = packument.versions ?? {};
  const times = packument.time ?? {};
  const kept = [];
  for (const [version, data] of Object.entries(versions)) {
    const bundle = data?.dsh?.bundle;
    if (!bundle || typeof bundle !== 'object') continue; // only versions that DSH can actually load
    if (!semver.valid(version)) continue; // the format requires an exact SemVer version
    const published = Date.parse(times[version] ?? '');
    if (!Number.isFinite(published)) continue;
    kept.push({
      version,
      publishTimestamp: Math.floor(published / 1000),
      declared: typeof data.engines?.dsh === 'string'
        && !data.engines.dsh.startsWith('workspace:')
        && semver.validRange(data.engines.dsh) !== null
        ? data.engines.dsh
        : undefined,
      peers: peerRanges(data),
    });
  }
  if (kept.length === 0) return null;

  const latest = packument['dist-tags']?.latest;
  const latestData = versions[latest]
    ?? versions[semver.maxSatisfying(kept.map((entry) => entry.version), '*') ?? kept[0].version]
    ?? {};

  const keywords = Array.isArray(latestData.keywords)
    ? [...new Set(latestData.keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim() !== '').map((keyword) => keyword.trim()))].slice(0, 25)
    : [];

  return {
    name,
    description: typeof latestData.description === 'string' ? latestData.description : (typeof packument.description === 'string' ? packument.description : undefined),
    homepage: normalizeHomepage(latestData.homepage ?? packument.homepage),
    repository: normalizeRepository(latestData.repository ?? packument.repository),
    author: authorName(latestData.author ?? packument.author),
    keywords,
    versions: kept,
  };
}

async function loadPackument(name) {
  const cacheFile = cacheName(name);
  if (CONFIG.useCache && existsSync(cacheFile)) {
    const stats = await fs.stat(cacheFile);
    if (Date.now() - stats.mtimeMs < CONFIG.packumentTtlMs) {
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        return { meta: cached?.skipped ? null : cached, status: 'cache' };
      } catch { /* fall through to the network */ }
    }
  }
  const result = await fetchWithRetry(packumentUrl(name));
  if (!result.body) return { meta: null, status: result.status };
  let packument;
  try { packument = JSON.parse(result.body); } catch { return { meta: null, status: 'unparseable' }; }
  const meta = extract(name, packument);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(meta ?? { skipped: true }));
  return { meta, status: 200 };
}

/* --------------------------------------------------------------- downloads */

async function fetchDownloads(names) {
  const cacheFile = path.join(CONFIG.cacheDir, 'downloads.json');
  let cached = {};
  if (CONFIG.useCache && existsSync(cacheFile)) {
    try { cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { cached = {}; }
  }
  const downloads = new Map();
  const pending = [];
  for (const name of names) {
    const entry = cached[name];
    if (entry && Date.now() - entry.at < CONFIG.packumentTtlMs) {
      if (typeof entry.downloads === 'number') downloads.set(name, entry.downloads);
    } else {
      pending.push(name);
    }
  }
  log(`downloads: ${downloads.size} cached, ${pending.length} to fetch`);

  // The npm downloads API rate-limits per-package requests hard (Cloudflare "1015") and its bulk
  // lookup rejects scoped names, so: batch the unscoped names, then ask scoped ones individually
  // under a small concurrency, and stop the whole phase as soon as it starts refusing.
  const unscoped = pending.filter((name) => !name.startsWith('@'));
  const scoped = pending.filter((name) => name.startsWith('@'));

  let failures = 0;
  let blocked = 0;
  const BATCH = 64;
  const batchQueue = [];
  for (let index = 0; index < unscoped.length; index += BATCH) batchQueue.push(unscoped.slice(index, index + BATCH));

  while (batchQueue.length > 0) {
    if (blocked >= 4) { log('downloads: rate-limited, keeping what we have'); break; }
    const batch = batchQueue.shift();
    let payload = null;
    try {
      const result = await fetchWithRetry(`https://api.npmjs.org/downloads/point/last-week/${batch.join(',')}`, { timeoutMs: 20_000, retries: 1 });
      if (result.body) payload = JSON.parse(result.body);
    } catch { /* counted below */ }
    if (!payload || typeof payload !== 'object' || payload.error) {
      // A single bad name can poison a whole batch: bisect before giving up.
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        batchQueue.unshift(batch.slice(0, middle), batch.slice(middle));
      } else {
        blocked += 1;
        failures += 1;
      }
      await sleep(150);
      continue;
    }
    blocked = 0;
    for (const name of batch) {
      const entry = payload[name];
      const value = entry && typeof entry.downloads === 'number' ? entry.downloads : null;
      cached[name] = { downloads: value, at: Date.now() };
      if (value != null) downloads.set(name, value);
    }
    await sleep(120);
  }

  if (scoped.length > 0 && blocked < 3) {
    const queue = [...scoped];
    let refused = 0;
    const worker = async () => {
      while (queue.length && refused < 3) {
        const name = queue.shift();
        try {
          const result = await fetchWithRetry(`https://api.npmjs.org/downloads/point/last-week/${name.replace('/', '%2F')}`, { timeoutMs: 10_000, retries: 0 });
          const parsed = result.body ? JSON.parse(result.body) : null;
          if (!parsed || typeof parsed.downloads !== 'number') { refused += 1; failures += 1; continue; }
          refused = 0;
          cached[name] = { downloads: parsed.downloads, at: Date.now() };
          downloads.set(name, parsed.downloads);
        } catch { refused += 1; failures += 1; }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (refused >= 3) log(`downloads: stopped scoped lookups (${queue.length} left)`);
  }

  if (pending.length > 0) {
    await fs.mkdir(CONFIG.cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(cached));
  }
  log(`downloads: ${downloads.size}/${names.length} resolved, ${failures} failed`);
  return downloads;
}

/* ------------------------------------------------------------------ build */

function labelsFor(downloads) {
  const labels = [];
  if (downloads == null) return labels;
  for (const [id, threshold] of [['downloads-100000', 100_000], ['downloads-50000', 50_000], ['downloads-10000', 10_000], ['downloads-5000', 5_000], ['downloads-1000', 1_000]]) {
    if (downloads >= threshold) { labels.push(id); break; }
  }
  return labels;
}

function buildIndex(metas, downloads) {
  const plugins = [];
  const seen = new Set();
  let skippedNames = 0;
  for (const meta of [...metas].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!isIndexableName(meta.name)) { skippedNames += 1; continue; }
    if (seen.has(meta.name)) continue;
    seen.add(meta.name);
    const versions = [...meta.versions]
      .sort((left, right) => semver.rcompare(left.version, right.version))
      .slice(0, CONFIG.maxVersionsPerPlugin)
      .map((entry) => {
        const engine = entry.declared ?? intersectRanges(entry.peers);
        return {
          version: entry.version,
          publishTimestamp: entry.publishTimestamp,
          source: { type: 'npm' },
          ...engine ? { engines: { dsh: engine } } : {},
        };
      });
    if (versions.length === 0) continue;

    const weekly = downloads.get(meta.name);
    const metadata = {};
    if (weekly != null) {
      metadata.sortKeys = { downloads: weekly };
      metadata.labels = labelsFor(weekly);
    }
    if (meta.keywords.length > 0) metadata.keywords = meta.keywords;

    const description = typeof meta.description === 'string' ? meta.description.trim().slice(0, 500) : '';
    // Re-sanitize at build time: cached metas may predate the current normalization rules.
    const repository = normalizeRepository(meta.repository);
    const homepage = normalizeHomepage(meta.homepage);
    plugins.push({
      name: meta.name,
      ...description !== '' ? { description } : {},
      ...meta.author ? { author: meta.author } : {},
      ...homepage ? { homepage } : {},
      ...repository ? { repository } : {},
      metadata,
      versions,
    });
  }

  if (skippedNames > 0) log(`skipped ${skippedNames} names the format cannot express`);

  return {
    format: 1,
    title: CONFIG.title,
    description: CONFIG.description,
    metadata: {
      labels: Object.fromEntries(Object.entries(CONFIG.labels).map(([id, title]) => [id, { title }])),
      sortKeys: { downloads: { title: { en: 'Weekly downloads', zh: '周下载量' }, order: 'desc' } },
    },
    plugins,
  };
}

/** One plugin per line: valid JSON, keeps git diffs readable, and stays compact on the wire. */
function serialize(index) {
  const head = JSON.stringify({ format: index.format, title: index.title, description: index.description, metadata: index.metadata });
  const body = index.plugins.map((plugin) => JSON.stringify(plugin)).join(',\n');
  return `${head.slice(0, -1)},"plugins":[\n${body}\n]}\n`;
}

/* ------------------------------------------------------------------- main */

async function main() {
  log('discovering package names');
  let names = await discover();
  if (CONFIG.limit > 0) names = names.slice(0, CONFIG.limit);
  log(`${names.length} candidate names`);

  const metas = [];
  const stats = { notFound: 0, noBundle: 0, fetched: 0 };
  let index = 0;
  await pool(names, async (name) => {
    try {
      const { meta, status } = await loadPackument(name);
      index += 1;
      if (!meta) {
        if (status === 404) stats.notFound += 1; else stats.noBundle += 1;
        return;
      }
      metas.push(meta);
      stats.fetched += 1;
    } catch (error) {
      stats.noBundle += 1;
      if (stats.noBundle % 200 === 0) log(`still failing: ${error.message}`);
    }
  }, CONFIG.concurrency, (done) => log(`packuments ${done}/${names.length} — ${metas.length} bundles`));
  log(`bundles: ${metas.length} (404: ${stats.notFound}, no bundle: ${stats.noBundle})`);

  const downloads = CONFIG.useDownloads ? await fetchDownloads(metas.map((meta) => meta.name)) : new Map();
  const indexDocument = buildIndex(metas, downloads);

  try {
    const parsed = parseMarketIndex(indexDocument, CONFIG.indexUrl);
    log(`validator OK: ${parsed.plugins.length} plugins`);
  } catch (error) {
    log(`VALIDATOR REJECTED THE INDEX: ${error.path} ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const text = serialize(indexDocument);
  await fs.mkdir(path.dirname(CONFIG.outFile), { recursive: true });
  await fs.writeFile(CONFIG.outFile, text);
  const bytes = Buffer.byteLength(text);
  const versionCount = indexDocument.plugins.reduce((total, plugin) => total + plugin.versions.length, 0);
  log(`wrote ${CONFIG.outFile} — ${indexDocument.plugins.length} plugins, ${versionCount} versions, ${(bytes / 1024 / 1024).toFixed(2)} MB raw`);
}

await main();
