#!/usr/bin/env node
/**
 * Clauge — Claude Code token analytics & subscription ROI dashboard.
 * V1 scaffold. Full feature set arrives over PRD v3.1 §2.10 build steps.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import 'dotenv/config';
import open from 'open';

import { parseSession, resolveProjectName } from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT ?? 3456);
const CLAUDE_DIR = (process.env.CLAUDE_DIR ?? join(homedir(), '.claude'))
  .replace(/^~(?=\/)/, homedir());

async function listSessionFiles() {
  const root = join(CLAUDE_DIR, 'projects');
  const projects = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projDir = join(root, entry.name);
    let files;
    try {
      files = await readdir(projDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        projects.push({
          dirName: entry.name,
          file: join(projDir, f),
        });
      }
    }
  }
  return projects;
}

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    version: '0.1.0',
    claudeDir: CLAUDE_DIR,
  })
);

app.get('/api/sessions/index', async (c) => {
  const files = await listSessionFiles();
  return c.json({
    count: files.length,
    sessions: files.map((s) => ({
      dirName: s.dirName,
      project: resolveProjectName(null, s.dirName),
      file: s.file,
    })),
  });
});

app.get('/api/sessions/:sessionId/raw', async (c) => {
  const sessionId = c.req.param('sessionId');
  const files = await listSessionFiles();
  const match = files.find((f) => f.file.endsWith(`${sessionId}.jsonl`));
  if (!match) return c.json({ error: 'session not found' }, 404);
  const turns = await parseSession(match.file);
  return c.json({ sessionId, turnCount: turns.length, turns });
});

app.use('/*', serveStatic({ root: join(__dirname, 'public') }));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`[Clauge] Listening on ${url}`);
  console.log(`[Clauge] CLAUDE_DIR=${CLAUDE_DIR}`);
  if (process.env.NO_OPEN !== '1') {
    open(url).catch(() => {
      console.log('[Clauge] (could not auto-open browser; visit URL manually)');
    });
  }
});

const shutdown = (signal) => {
  console.log(`\n[Clauge] ${signal} received — shutting down`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
