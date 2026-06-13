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

export const SUMMARY_LOAD_CONCURRENCY = 8;

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
   *
   * Parses at most SUMMARY_LOAD_CONCURRENCY files at a time. A cold cache on a
   * large ~/.claude (~1.1 GB / 2647 files) would otherwise fan an unbounded
   * Promise.all over every file, holding the whole transcript corpus + parsed
   * turns in memory at once (~4 GB → OOM-killed the sidecar). Batching bounds
   * peak transient memory to a handful of files; the warm path (stat-only
   * cache hits) is unaffected. parser.js already streams each file line-by-line,
   * so per-file memory is small — the cap is purely about how many run at once.
   */
  async loadAllSummaries() {
    const files = await this.listFiles();
    const summaries = [];
    for (let i = 0; i < files.length; i += SUMMARY_LOAD_CONCURRENCY) {
      const batch = files.slice(i, i + SUMMARY_LOAD_CONCURRENCY);
      const results = await Promise.all(
        batch.map(({ file, encodedDirName }) =>
          this.loadSummary(file, encodedDirName).catch((err) => {
            // Don't let a single bad file kill the whole load.
            console.error(`[Clauge] failed to summarize ${file}:`, err.message);
            return null;
          })
        )
      );
      for (const summary of results) {
        if (summary) summaries.push(summary);
      }
    }
    return summaries;
  }

  invalidate() {
    this.cache.clear();
  }
}
