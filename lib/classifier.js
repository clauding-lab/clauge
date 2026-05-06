/**
 * Task classification per PRD v3.1 §2.5.
 *
 * Deterministic, no LLM calls. Precedence rules (first match wins):
 *   1. Testing      — Bash first-token in test runners
 *   2. Build        — Bash first-token in build commands
 *   3. GitOps       — Bash first-token == git AND second token in git verbs
 *   4. Coding       — tool name in {Edit, Write, NotebookEdit}
 *   5. Debugging    — tool use AND adjacent user text matches debug regex
 *   6. Exploration  — tool name in {Read, Grep, Glob} AND no Edit/Write
 *   7. Planning     — no tool use AND user text matches planning regex
 *   8. Conversation — default
 *
 * Honesty: this is a "primary intent (heuristic)" label, not ground truth.
 */

export const CATEGORIES = Object.freeze([
  'Testing',
  'Build',
  'GitOps',
  'Coding',
  'Debugging',
  'Exploration',
  'Planning',
  'Conversation',
]);

const TEST_RUNNERS = new Set([
  'pytest', 'vitest', 'jest', 'mocha', 'jasmine',
  'go', 'cargo', 'phpunit', 'rspec',
]);
const TEST_NPM_SCRIPTS = new Set(['test']);

const BUILD_COMMANDS = new Set([
  'docker', 'make', 'tsc', 'webpack', 'rollup', 'esbuild',
  'pip', 'pipx', 'poetry', 'cargo',
]);
const BUILD_NPM_SCRIPTS = new Set(['build', 'compile']);
const BUILD_FRAMEWORK_VERBS = new Set(['build']);

const GIT_VERBS = new Set([
  'push', 'commit', 'merge', 'rebase', 'pull', 'checkout',
  'branch', 'reset', 'stash', 'tag', 'cherry-pick',
]);

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob']);

const DEBUG_REGEX = /\b(error|fail|failing|bug|broken|exception|stack[- ]?trace|fix|debug)\b/i;
const PLAN_REGEX = /\b(plan|design|architecture|approach|strategy)\b/i;

/**
 * Split a Bash command into segments delimited by &&, ||, or ;.
 * Strips leading env-var prefixes (e.g., "DEBUG=1 npm run dev" → "npm run dev").
 */
export function splitBashSegments(command) {
  if (!command || typeof command !== 'string') return [];
  return command
    .split(/&&|\|\||;/)
    .map((seg) => seg.trim())
    .map((seg) => seg.replace(/^([A-Z_][A-Z0-9_]*=\S+\s+)+/i, ''))
    .filter(Boolean);
}

/**
 * Get the first non-prefix token of a Bash command segment.
 * Examples: "git push" → "git", "DEBUG=1 npm test" → "npm".
 */
export function firstToken(commandSegment) {
  if (!commandSegment) return null;
  const tokens = commandSegment.split(/\s+/).filter(Boolean);
  return tokens[0] ?? null;
}

function bashSegmentMatchesTest(segment) {
  const t1 = firstToken(segment);
  if (!t1) return false;
  if (TEST_RUNNERS.has(t1)) return true;
  // npm test, yarn test, pnpm test
  if (['npm', 'yarn', 'pnpm', 'bun'].includes(t1)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const next = tokens[1];
    if (!next) return false;
    if (TEST_NPM_SCRIPTS.has(next)) return true;
    if (next === 'run' && TEST_NPM_SCRIPTS.has(tokens[2])) return true;
  }
  // go test, cargo test
  if (t1 === 'go' || t1 === 'cargo') {
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens[1] === 'test') return true;
  }
  return false;
}

function bashSegmentMatchesBuild(segment) {
  const t1 = firstToken(segment);
  if (!t1) return false;
  if (BUILD_COMMANDS.has(t1)) return true;
  if (['npm', 'yarn', 'pnpm', 'bun'].includes(t1)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const next = tokens[1];
    if (BUILD_NPM_SCRIPTS.has(next)) return true;
    if (next === 'run' && BUILD_NPM_SCRIPTS.has(tokens[2])) return true;
    if (next === 'install') return true; // npm install is build-adjacent
  }
  // Framework CLIs: vite build, next build, nuxt build, astro build
  if (['vite', 'next', 'nuxt', 'astro', 'remix', 'svelte-kit'].includes(t1)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (BUILD_FRAMEWORK_VERBS.has(tokens[1])) return true;
  }
  return false;
}

function bashSegmentMatchesGit(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens[0] !== 'git') return false;
  return GIT_VERBS.has(tokens[1]);
}

function getToolNamesAndBashSegments(turn) {
  const tools = [];
  const bashSegments = [];
  for (const block of turn.contentBlocks ?? []) {
    if (block?.type !== 'tool_use' || !block.name) continue;
    tools.push(block.name);
    if (block.name === 'Bash') {
      const cmd = block.input?.command;
      bashSegments.push(...splitBashSegments(cmd));
    }
  }
  return { tools, bashSegments };
}

/**
 * Classify one deduplicated assistant turn.
 *
 * @param {object} turn from parser.parseSession
 * @param {string} prevUserText concatenated text of adjacent user turn
 * @returns {string} one of CATEGORIES
 */
export function classify(turn, prevUserText = '') {
  const { tools, bashSegments } = getToolNamesAndBashSegments(turn);
  const hasTools = tools.length > 0;

  // 1. Testing
  if (bashSegments.some(bashSegmentMatchesTest)) return 'Testing';
  // 2. Build
  if (bashSegments.some(bashSegmentMatchesBuild)) return 'Build';
  // 3. GitOps
  if (bashSegments.some(bashSegmentMatchesGit)) return 'GitOps';
  // 4. Coding
  if (tools.some((n) => EDIT_TOOLS.has(n))) return 'Coding';
  // 5. Debugging
  if (hasTools && DEBUG_REGEX.test(prevUserText)) return 'Debugging';
  // 6. Exploration
  if (hasTools && tools.every((n) => EXPLORE_TOOLS.has(n))) return 'Exploration';
  // 7. Planning
  if (!hasTools && PLAN_REGEX.test(prevUserText)) return 'Planning';
  // 8. default
  return 'Conversation';
}

/**
 * Walk a turn list and return classification per assistant turn,
 * threading the adjacent user-text via parentUuid linkage.
 */
export function classifyAll(turns) {
  const userTextByUuid = new Map();
  for (const t of turns) {
    if (t.type !== 'user') continue;
    const text = extractUserText(t.message);
    if (text) userTextByUuid.set(t.uuid, text);
  }
  const out = [];
  for (const t of turns) {
    if (t.type !== 'assistant') continue;
    const prevText = userTextByUuid.get(t.parentUuid) ?? '';
    out.push({
      uuid: t.uuid,
      requestId: t.requestId,
      category: classify(t, prevText),
    });
  }
  return out;
}

function extractUserText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === 'string' ? b : (b?.text ?? '')))
      .join(' ');
  }
  return '';
}
