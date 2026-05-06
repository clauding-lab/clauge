import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTools, extractMcpServer } from '../lib/tool-analyzer.js';

const t = (name, input = {}) => ({ type: 'tool_use', name, input });
const turn = (blocks) => ({ type: 'assistant', contentBlocks: blocks });

describe('extractMcpServer', () => {
  it('parses mcp__<server>__<tool> form', () => {
    assert.equal(extractMcpServer('mcp__supabase__execute_sql'), 'supabase');
    assert.equal(extractMcpServer('mcp__github__list_pull_requests'), 'github');
  });

  it('parses mcp__plugin_<plugin>_<server>__<tool> form', () => {
    assert.equal(
      extractMcpServer('mcp__plugin_supabase_supabase__execute_sql'),
      'supabase'
    );
    assert.equal(
      extractMcpServer('mcp__plugin_playwright_playwright__browser_click'),
      'playwright'
    );
  });

  it('returns null for non-MCP tool names', () => {
    assert.equal(extractMcpServer('Read'), null);
    assert.equal(extractMcpServer('Bash'), null);
    assert.equal(extractMcpServer(null), null);
    assert.equal(extractMcpServer(''), null);
  });
});

describe('analyzeTools — frequency counts', () => {
  it('counts core tools, separates MCP servers', () => {
    const turns = [
      turn([t('Read'), t('Edit'), t('mcp__supabase__execute_sql')]),
      turn([t('Read'), t('mcp__plugin_github_github__list_pull_requests')]),
    ];
    const out = analyzeTools(turns);
    const core = Object.fromEntries(out.coreTools.map((x) => [x.name, x.count]));
    const mcp = Object.fromEntries(out.mcpServers.map((x) => [x.name, x.count]));
    assert.equal(core.Read, 2);
    assert.equal(core.Edit, 1);
    assert.equal(mcp.supabase, 1);
    assert.equal(mcp.github, 1);
  });

  it('extracts shell commands from Bash tool calls (split on &&, env-prefix-stripped)', () => {
    const turns = [
      turn([
        t('Bash', { command: 'git push && npm test' }),
        t('Bash', { command: 'DEBUG=1 npm run dev' }),
      ]),
    ];
    const out = analyzeTools(turns);
    const sh = Object.fromEntries(out.shellCommands.map((x) => [x.name, x.count]));
    assert.equal(sh.git, 1);
    assert.equal(sh.npm, 2); // npm test + npm run dev
  });

  it('sorts results by count desc, then name asc', () => {
    const turns = [turn([t('Read'), t('Read'), t('Bash', { command: 'ls' }), t('Edit')])];
    const out = analyzeTools(turns);
    assert.equal(out.coreTools[0].name, 'Read');
    assert.equal(out.coreTools[0].count, 2);
  });

  it('ignores non-assistant turns', () => {
    const turns = [{ type: 'user', contentBlocks: [t('Read')] }];
    const out = analyzeTools(turns);
    assert.equal(out.coreTools.length, 0);
  });
});
