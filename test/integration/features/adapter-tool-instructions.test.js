'use strict';

/**
 * Tool-instruction guidance in adapters (originally v6.1.0; reworked in v7.0 / #239).
 *
 * The canonical "## SigMap commands" guidance block is now emitted ONCE from
 * `formatOutput()` (the single content source every writer consumes), instead
 * of each adapter inventing its own divergent variant (markdown table vs.
 * bullets vs. `#` comments vs. prose). This file asserts the new contract:
 *
 *   - adapters no longer embed their own bespoke guidance in format()
 *   - the canonical block still reaches every generated file (full-pipeline
 *     verification lives in test/integration/context-consistency.test.js)
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../../..');
function loadAdapter(name) { return require(path.join(ROOT, 'packages', 'adapters', name)); }

const CTX = '## src\n\n### src/api/routes.ts\n```\nexport function getUsers(req, res)\n```';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}: ${err.message}`); failed++; }
}

// Stale per-adapter guidance strings that must NOT reappear in format() output —
// they would mean an adapter went back to inventing its own divergent block.
const STALE = {
  claude: ['## SigMap\n', '- Before searching for files'],
  cursor: ['# SigMap: before answering'],
  windsurf: ['# SigMap: before answering'],
  gemini: ['suggest running `sigmap ask'],
  openai: ['prefer running `sigmap ask'],
  codex: ['<!-- sigmap-tools -->', '"sigmap_ask"'],
};

for (const [name, markers] of Object.entries(STALE)) {
  test(`${name}: format() no longer embeds bespoke guidance`, () => {
    const out = loadAdapter(name).format(CTX, { version: '7.0.0' });
    for (const m of markers) {
      assert.ok(!out.includes(m), `${name} format() still contains stale marker: ${JSON.stringify(m)}`);
    }
  });
}

test('usage-guidance module exposes one canonical SigMap commands table', () => {
  const { usageBlock } = require(path.join(ROOT, 'src', 'format', 'usage-guidance'));
  const block = usageBlock();
  assert.ok(/## SigMap commands/.test(block), 'heading missing');
  // Assert the COMMAND, not the placeholder wording — this previously pinned
  // `sigmap ask "<your question>"` verbatim, so rewording the prompt text broke
  // a test that is supposed to be about which commands are published (#754).
  assert.ok(/`sigmap ask "</.test(block), 'ask command missing');
  assert.ok(/`sigmap validate`/.test(block), 'validate command missing');
});

test('the block tells the agent to run the commands, not just that they exist', () => {
  // A reference table is something an agent reads past. The reported symptom was
  // "the LLM does not pick it up", and a passive list is why (#754).
  const { usageBlock } = require(path.join(ROOT, 'src', 'format', 'usage-guidance'));
  const block = usageBlock();
  assert.ok(/\*\*Run these yourself/.test(block),
    'the block must instruct the agent to run the commands itself');
  assert.ok(/no model call/.test(block),
    'the block should say the commands are free, or an agent will ration them');
});

test('the block publishes the commands that change cost or grounding', () => {
  const { usageBlock } = require(path.join(ROOT, 'src', 'format', 'usage-guidance'));
  const block = usageBlock();
  for (const [cmd, why] of [
    ['sigmap lines',    'reading an anchored range instead of a whole file is the biggest single saving'],
    ['sigmap --impact', 'blast radius before editing a file'],
    ['sigmap --callers', 'blast radius before changing a function'],
    ['sigmap verify',   'the grounding guard — the whole point of the product'],
    ['sigmap explain',  'why a file is or is not in context'],
  ]) {
    assert.ok(block.includes(cmd), `${cmd} missing from the canonical block — ${why}`);
  }
});

test('the block stays small enough to ship in every context file', () => {
  // It is emitted in EVERY generated context file, and under `strategy:"index"`
  // the whole always-on file is ~500 tokens — so this is paid per question.
  const { usageBlock } = require(path.join(ROOT, 'src', 'format', 'usage-guidance'));
  const tokens = Math.round(usageBlock().length / 4);
  assert.ok(tokens < 320, `usage block is ${tokens} tokens — too large to ship always-on`);
});

console.log(`\nadapter-tool-instructions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
