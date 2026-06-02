/**
 * In-memory cache over parsed/summarized sessions.
 *
 * Cache key: file path. Cache value: { mtimeMs, summary }.
 * On every access, we stat the file; if mtime hasn't changed, we serve
 * the cached summary. Otherwise we re-parse + re-summarize.
 *
 * This makes the dashboard responsive even with hundreds of sessions and
 * keeps disk reads minimal.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseSession } from './parser.js';
import { summarizeSession } from './aggregator.js';

export class SessionStore {
  constructor({ claudeDir, priceTable, envFallback } = {}) {
    this.claudeDir = (claudeDir ?? join(homedir(), '.claude')).replace(/^~(?=\/)/, homedir());
    this.priceTable = priceTable;
    this.envFallback = envFallback;
    this.cache = new Map(); // filePath → { mtimeMs, summary }
  }

  setPriceTable(priceTable) {
    this.priceTable = priceTable;
    // Invalidate cached summaries — costs depend on rates.
    this.cache.clear();
  }

  async listFiles() {
    const root = join(this.claudeDir, 'projects');
    const out = [];
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return out;
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
          out.push({ encodedDirName: entry.name, file: join(projDir, f) });
        }
      }
    }
    return out;
  }

  async loadSummary(filePath, encodedDirName) {
    const stats = await stat(filePath);
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      return cached.summary;
    }
    const turns = await parseSession(filePath);
    const summary = summarizeSession(turns, {
      priceTable: this.priceTable,
      envFallback: this.envFallback,
      encodedDirName,
    });
    this.cache.set(filePath, { mtimeMs: stats.mtimeMs, summary });
    return summary;
  }

  /**
   * Load all session summaries (cache-friendly). Sessions with no
   * assistant turns return null and are filtered out.
   */
  async loadAllSummaries() {
    const files = await this.listFiles();
    const summaries = await Promise.all(
      files.map(({ file, encodedDirName }) =>
        this.loadSummary(file, encodedDirName).catch((err) => {
          // Don't let a single bad file kill the whole load.
          console.error(`[Clauge] failed to summarize ${file}:`, err.message);
          return null;
        })
      )
    );
    return summaries.filter(Boolean);
  }

  invalidate() {
    this.cache.clear();
  }
}
