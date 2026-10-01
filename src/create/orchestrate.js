'use strict';

/**
 * create orchestrator (IMPL.md §6.2 — the capstone of the grounded-creation loop).
 *
 * Sequences the four guard stages — scaffold → verify-plan → verify-ai-output →
 * review-pr — in one pass with `n/4` numbering and a single pass/fail summary.
 * The agent does the LLM writing between stages; `create` runs the deterministic
 * guards it owns. A stage runs only when its input is present (else it is
 * skipped, which does not fail the run). Zero-dependency, bundle-safe; delegates
 * to the real stage modules.
 *
 * A run where NOTHING ran is reported as `nothingRan`, not as a pass (#767):
 * `failed === 0` is vacuously true over an empty set, so a CI step that shelled
 * out to `create` with no inputs read success from a run that verified nothing.
 *
 * The scaffold stage's proposed filenames are handed to verify-plan as
 * introductions (#666), so the pipeline's own primary use case — a plan for code
 * that does not exist yet — can reach stage 2 instead of failing on itself.
 */

const { proposeScaffold } = require('../scaffold/propose');
const { verifyPlan } = require('../plan/verify-plan');
const { verify } = require('../verify/hallucination-guard');
const { reviewPr } = require('../review/review-pr');

const TOTAL = 4;

/** What each stage needs in order to run — printed when nothing ran (#767). */
const STAGE_NEEDS = {
  scaffold: '--name <module> (plus a detectable file-naming convention)',
  'verify-plan': '--plan <plan.md>',
  'verify-ai-output': '--answer <answer.md>',
  'review-pr': '--staged, or commits since --base',
};

/** Files a successful scaffold proposes — introductions for verify-plan. */
function _scaffoldIntroductions(step) {
  const p = step && step.ran && step.ok && step.detail && step.detail.proposal;
  if (!p) return [];
  return [p.filename, p.testFile].filter(Boolean);
}

/**
 * Run the create pipeline over whatever inputs are available.
 * @param {object} ctx
 * @param {string} [ctx.task] free-text task label (echoed back)
 * @param {string} [ctx.name] module name → enables the scaffold stage
 * @param {object} [ctx.conventions] an `extractConventions` result (for scaffold)
 * @param {object} [ctx.scaffoldOpts] options forwarded to `proposeScaffold`
 * @param {string} [ctx.plan] plan markdown → enables verify-plan
 * @param {string[]} [ctx.creates] names the plan introduces, forwarded to
 *   verify-plan alongside the scaffold's own proposed filenames
 * @param {string} [ctx.answer] AI answer markdown → enables verify-ai-output
 * @param {Array<{path:string,status:string}>} [ctx.changedFiles] → enables review-pr
 * @param {string} cwd repo root
 * @returns {{ task: string|null, steps: object[], summary: object }}
 */
function orchestrate(ctx = {}, cwd) {
  const steps = [];
  const skip = (n, name, reason) =>
    ({ n, total: TOTAL, name, ran: false, ok: null, skipped: true, reason, needs: STAGE_NEEDS[name] });

  // 1/4 — scaffold (needs a name + conventions)
  if (ctx.name && ctx.conventions) {
    const d = proposeScaffold(ctx.name, ctx.conventions, ctx.scaffoldOpts || {});
    steps.push({ n: 1, total: TOTAL, name: 'scaffold', ran: true, ok: !!d.ok, skipped: false, detail: d });
  } else {
    steps.push(skip(1, 'scaffold', 'no --name'));
  }

  // 2/4 — verify-plan (needs a plan). The scaffold's proposed files are
  // introductions, so stage 2 does not reject the files stage 1 just designed.
  if (ctx.plan != null && String(ctx.plan).trim() !== '') {
    const creates = [...(ctx.creates || []), ..._scaffoldIntroductions(steps[0])];
    const r = verifyPlan(ctx.plan, cwd, creates.length ? { creates } : {});
    steps.push({ n: 2, total: TOTAL, name: 'verify-plan', ran: true, ok: !!r.summary.ok, skipped: false, detail: r });
  } else {
    steps.push(skip(2, 'verify-plan', 'no --plan'));
  }

  // 3/4 — verify-ai-output (needs an answer)
  if (ctx.answer != null && String(ctx.answer).trim() !== '') {
    const r = verify(ctx.answer, cwd);
    steps.push({ n: 3, total: TOTAL, name: 'verify-ai-output', ran: true, ok: r.summary.total === 0, skipped: false, detail: r });
  } else {
    steps.push(skip(3, 'verify-ai-output', 'no --answer'));
  }

  // 4/4 — review-pr (needs changed files)
  if (Array.isArray(ctx.changedFiles) && ctx.changedFiles.length) {
    const r = reviewPr(ctx.changedFiles, cwd);
    steps.push({ n: 4, total: TOTAL, name: 'review-pr', ran: true, ok: !!r.summary.ok, skipped: false, detail: r });
  } else {
    steps.push(skip(4, 'review-pr', 'no changes'));
  }

  const ran = steps.filter((s) => s.ran);
  const passed = ran.filter((s) => s.ok).length;
  const failed = ran.length - passed;
  const nothingRan = ran.length === 0;
  return {
    task: ctx.task || null,
    steps,
    summary: {
      total: TOTAL,
      ran: ran.length,
      skipped: steps.length - ran.length,
      passed,
      failed,
      nothingRan,
      // A run that verified nothing is not a pass: `failed === 0` is vacuously
      // true over an empty set, which is exactly the false CI pass of #767.
      ok: !nothingRan && failed === 0,
    },
  };
}

module.exports = { orchestrate, TOTAL, STAGE_NEEDS };
