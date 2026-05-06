/**
 * Tool / shell / MCP analytics per PRD v3.1 §2.4.
 *
 * MCP server name extraction handles two patterns:
 *   mcp__<server>__<tool>
 *   mcp__plugin_<plugin>_<server>__<tool>
 */

import { splitBashSegments, firstToken } from './classifier.js';

const MCP_PREFIX = 'mcp__';
const MCP_PLUGIN_PREFIX = 'mcp__plugin_';

/**
 * Extract the MCP server name from a tool_use block name.
 * Returns null if the name doesn't follow MCP convention.
 */
export function extractMcpServer(toolName) {
  if (!toolName || !toolName.startsWith(MCP_PREFIX)) return null;
  if (toolName.startsWith(MCP_PLUGIN_PREFIX)) {
    // mcp__plugin_<plugin>_<server>__<tool> — server is the last
    // underscore-segment of the prefix-portion before "__".
    const afterPrefix = toolName.slice(MCP_PLUGIN_PREFIX.length);
    const idx = afterPrefix.indexOf('__');
    if (idx < 0) return null;
    const head = afterPrefix.slice(0, idx); // "supabase_supabase" or similar
    const segs = head.split('_');
    return segs[segs.length - 1] ?? null;
  }
  // mcp__<server>__<tool>
  const afterPrefix = toolName.slice(MCP_PREFIX.length);
  const idx = afterPrefix.indexOf('__');
  return idx > 0 ? afterPrefix.slice(0, idx) : null;
}

/**
 * Walk all assistant turns and return tool/shell/MCP frequency counts.
 *
 * @returns {{coreTools, shellCommands, mcpServers}} each is a sorted array
 *   of `{ name, count }`.
 */
export function analyzeTools(turns) {
  const coreTools = new Map();
  const shellCommands = new Map();
  const mcpServers = new Map();

  for (const turn of turns ?? []) {
    if (turn.type !== 'assistant') continue;
    for (const block of turn.contentBlocks ?? []) {
      if (block?.type !== 'tool_use' || !block.name) continue;
      const name = block.name;

      const mcpServer = extractMcpServer(name);
      if (mcpServer) {
        mcpServers.set(mcpServer, (mcpServers.get(mcpServer) ?? 0) + 1);
      } else {
        coreTools.set(name, (coreTools.get(name) ?? 0) + 1);
      }

      if (name === 'Bash') {
        const cmd = block.input?.command;
        for (const seg of splitBashSegments(cmd)) {
          const first = firstToken(seg);
          if (first) {
            shellCommands.set(first, (shellCommands.get(first) ?? 0) + 1);
          }
        }
      }
    }
  }

  return {
    coreTools: toSortedArray(coreTools),
    shellCommands: toSortedArray(shellCommands),
    mcpServers: toSortedArray(mcpServers),
  };
}

function toSortedArray(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
