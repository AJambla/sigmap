/**
 * Canonical "how to use SigMap" guidance block (v6.16/v7.0).
 *
 * Every adapter emits this one identical block so all generated context files
 * (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, GEMINI.md, .cursorrules,
 * …) carry the same, single usage section — instead of each adapter inventing
 * its own wording (and codex emitting a redundant second JSON block).
 *
 * The block is DIRECTIVE, not a reference table (#754). A list of commands is
 * something an agent reads past; an instruction to run them is something it
 * acts on. Only commands that change what an answer COSTS or whether it is
 * GROUNDED earn a row here — this ships in every context file, and on the
 * `index` strategy the whole always-on file is ~500 tokens, so each row is
 * paid for on every question. `sigmap skills install` ships the long-form
 * playbook; this is what every agent gets without opting in.
 */

function usageBlock() {
  return [
    '## SigMap commands',
    '',
    '**Run these yourself in the terminal** — offline, deterministic, no model call.',
    '',
    '| When | Command |',
    '|------|---------|',
    '| Before answering anything about this code | `sigmap ask "<question>"` |',
    '| To read code you hold a `:start-end` anchor for | `sigmap lines <file> :<line> --context 10` |',
    '| Before editing a file / a function | `sigmap --impact <file>` · `sigmap --callers <symbol>` |',
    '| Before trusting generated code | `sigmap verify <answer.md>` |',
    '| To rank files by topic | `sigmap --query "<topic>"` |',
    '| Why a file is or is not in context | `sigmap explain <file>` |',
    '| After changing config or source dirs | `sigmap validate` |',
    '| To score an answer against this repo | `sigmap judge --response <file>` |',
    '',
    'Never open a file to "look around" — `sigmap ask` costs hundreds of tokens where',
    'reading the same files costs thousands. `:425-425` means line 425: read that range.',
    '',
  ].join('\n');
}

module.exports = { usageBlock };
