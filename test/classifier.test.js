import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  classifyAll,
  splitBashSegments,
  firstToken,
  CATEGORIES,
} from '../lib/classifier.js';

function asstTurn(blocks, opts = {}) {
  return {
    type: 'assistant',
    uuid: opts.uuid ?? 'a1',
    parentUuid: opts.parentUuid ?? 'u1',
    requestId: opts.requestId ?? 'req_x',
    contentBlocks: blocks,
  };
}
function bash(command) {
  return { type: 'tool_use', name: 'Bash', input: { command } };
}
function tool(name, input = {}) {
  return { type: 'tool_use', name, input };
}

describe('splitBashSegments + firstToken', () => {
  it('splits on &&, ||, and ;', () => {
    assert.deepEqual(splitBashSegments('git push && npm test || echo fail; ls'), [
      'git push',
      'npm test',
      'echo fail',
      'ls',
    ]);
  });

  it('strips env-var prefixes', () => {
    assert.deepEqual(splitBashSegments('DEBUG=1 npm run dev'), ['npm run dev']);
    assert.deepEqual(splitBashSegments('FOO=bar BAZ=qux ./script.sh'), [
      './script.sh',
    ]);
  });

  it('returns empty array for null/empty input', () => {
    assert.deepEqual(splitBashSegments(null), []);
    assert.deepEqual(splitBashSegments(''), []);
  });

  it('firstToken returns first whitespace-delimited word', () => {
    assert.equal(firstToken('git push origin main'), 'git');
    assert.equal(firstToken('   pytest -v'), 'pytest');
    assert.equal(firstToken(null), null);
  });
});

describe('classify — precedence rules (PRD §2.5)', () => {
  it('precedence #1: Testing wins over Coding when Bash runs tests', () => {
    const turn = asstTurn([
      tool('Edit', { file_path: '/x' }),
      bash('pytest -v'),
    ]);
    assert.equal(classify(turn, 'fix the bug'), 'Testing');
  });

  it('precedence #2: Build wins when npm run build present', () => {
    const turn = asstTurn([bash('npm run build')]);
    assert.equal(classify(turn), 'Build');
  });

  it('precedence #3: GitOps for git commit/push/etc.', () => {
    assert.equal(classify(asstTurn([bash('git push origin main')])), 'GitOps');
    assert.equal(classify(asstTurn([bash('git commit -m "x"')])), 'GitOps');
    assert.equal(classify(asstTurn([bash('git status')])), 'Conversation'); // status is not in GIT_VERBS
  });

  it('precedence #4: Coding for Edit/Write/NotebookEdit', () => {
    assert.equal(classify(asstTurn([tool('Edit')])), 'Coding');
    assert.equal(classify(asstTurn([tool('Write')])), 'Coding');
  });

  it('precedence #5: Debugging when tools + adjacent debug keyword', () => {
    const turn = asstTurn([tool('Read', { file_path: '/x' })]);
    assert.equal(classify(turn, 'I see an error in the build'), 'Debugging');
    assert.equal(classify(turn, 'debug this stack trace please'), 'Debugging');
  });

  it('precedence #6: Exploration for Read/Grep/Glob without edits', () => {
    const turn = asstTurn([tool('Read'), tool('Grep')]);
    assert.equal(classify(turn, 'show me the file'), 'Exploration');
  });

  it('precedence #7: Planning when no tools + planning keywords', () => {
    const turn = asstTurn([{ type: 'text', text: '...' }]);
    assert.equal(classify(turn, 'plan the migration approach'), 'Planning');
    assert.equal(classify(turn, 'what design fits?'), 'Planning');
  });

  it('precedence #8: Conversation as default', () => {
    const turn = asstTurn([{ type: 'text', text: 'thanks' }]);
    assert.equal(classify(turn, 'thanks'), 'Conversation');
  });

  it('chained Bash: first matching segment wins by precedence', () => {
    // Testing(1) > Build(2) > GitOps(3) — pytest first → Testing
    const turn = asstTurn([bash('pytest && npm run build && git push')]);
    assert.equal(classify(turn), 'Testing');
  });
});

describe('classifyAll — threads parentUuid linkage', () => {
  it('links assistant turn to adjacent user message via parentUuid', () => {
    const turns = [
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'plan the architecture' },
      },
      asstTurn([{ type: 'text', text: '...' }], { parentUuid: 'u1' }),
    ];
    const out = classifyAll(turns);
    assert.equal(out.length, 1);
    assert.equal(out[0].category, 'Planning');
  });

  it('handles user message content as array of blocks', () => {
    const turns = [
      {
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'fix the failing test' }],
        },
      },
      asstTurn([tool('Read')], { parentUuid: 'u1' }),
    ];
    const out = classifyAll(turns);
    assert.equal(out[0].category, 'Debugging');
  });

  it('returns empty array when no assistant turns', () => {
    assert.deepEqual(classifyAll([{ type: 'user', uuid: 'u1', message: { content: '' } }]), []);
  });
});

describe('CATEGORIES is the canonical list', () => {
  it('has exactly 8 categories', () => {
    assert.equal(CATEGORIES.length, 8);
  });
  it('is frozen', () => {
    assert.throws(() => CATEGORIES.push('Spam'));
  });
});
