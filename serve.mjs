#!/usr/bin/env node
/** serve.mjs — local static server for dist/ so DSH can load the index before it is published. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIR = path.join(ROOT, 'dist');
const port = Number(process.env.PORT ?? 8788);

const types = { '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const relative = url.pathname === '/' ? 'index.json' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(DIR, relative);
  if (!file.startsWith(DIR)) { response.writeHead(403).end('forbidden'); return; }
  try {
    const body = await fs.readFile(file);
    response.writeHead(200, {
      'content-type': types[path.extname(file)] ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${DIR}`);
  console.log(`index source: http://127.0.0.1:${port}/index.json`);
});
