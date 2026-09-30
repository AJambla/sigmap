'use strict';

/**
 * Integration tests for `sigmap redact` (v8.24 G3a).
 *
 * Tests:
 *  1.  redactText masks only the matched substring (surrounding text kept)
 *  2.  every pattern in security/patterns.js is masked by redactText
 *  3.  findings carry 1-based line numbers; counts aggregate per pattern
 *  4.  clean text passes through byte-identical with redacted: false
 *  5.  CLI redact <file>: redacted text on stdout, summary on stderr
 *  6.  CLI stdin + --json returns the result object
 *  7.  unquoted .env/YAML assignments are masked; short, empty and benign
 *      lines are left untouched (#668)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'gen-context.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

const { redactText } = require(path.join(ROOT, 'src', 'security', 'redact'));
const { PATTERNS } = require(path.join(ROOT, 'src', 'security', 'patterns'));

// One realistic sample per pattern name.
// Samples are assembled at runtime so no secret-shaped literal exists in this
// file — GitHub Push Protection scans committed blobs and rejects otherwise.
const AL = 'abcdefghijklmnopqrstuvwxyz';
const SAMPLES = {
  'AWS Access Key': `key ${'AK' + 'IA'}1234567890ABCDEF end`,
  'AWS Secret Key': `aws_secret = "${AL + AL.toUpperCase().slice(0, 10)}0123`.padEnd(52, '4') + '"',
  'GCP API Key': `k ${'AI' + 'za'}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 z`,
  'GitHub Token': 'gh' + 'p_' + AL + '0123456789',
  'JWT Token': `bearer ${'ey' + 'J'}hbGciOiJIUzI1NiJ9.${'ey' + 'J'}zdWIiOiIxIn0.abc-123_x`,
  'DB Connection String': `url ${'postgres' + '://'}admin:hunter2@db.example.com/prod`,
  'SSH Private Key': ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' '),
  'Stripe Key': 'sk_' + 'live_' + AL.slice(0, 24),
  'Twilio Key': `sid ${'S' + 'K'}0123456789abcdef0123456789abcdef done`,
  // The `sk-` / Slack family (#771). Assembled like the rest so no
  // secret-shaped literal is committed.
  'Anthropic API Key': `key ${'sk' + '-ant-'}api03-${AL}${AL.slice(0, 6)} end`,
  'OpenAI API Key': `key ${'sk' + '-proj-'}${AL}${AL.toUpperCase().slice(0, 6)} end`,
  'OpenAI API Key (legacy)': `key ${'sk' + '-'}${AL}${AL.toUpperCase().slice(0, 8)} end`,
  'Slack Token': `bot ${'xo' + 'xb-'}2345678901-2345678901234-${AL.slice(0, 12)} end`,
  'Slack Webhook': `hook ${'https://hooks.' + 'slack.com'}/services/T00000000/B00000000/${AL.toUpperCase().slice(0, 20)} end`,
  'Generic Secret': `password = ${'"correct-horse-battery"'}`,
};

console.log('[redact.test.js] v8.24 G3a standalone redaction');
console.log('');

test('masks only the matched substring, keeps surrounding text', () => {
  const r = redactText('before AKIA1234567890ABCDEF after');
  assert.strictEqual(r.text, 'before [REDACTED:AWS Access Key] after');
  assert.strictEqual(r.redacted, true);
});

test('every pattern in patterns.js is masked', () => {
  for (const p of PATTERNS) {
    const sample = SAMPLES[p.name];
    assert.ok(sample, `no sample for pattern "${p.name}" — add one`);
    const r = redactText(sample);
    assert.ok(r.text.includes(`[REDACTED:${p.name}]`),
      `pattern "${p.name}" not masked; got: ${r.text}`);
  }
});

test('findings carry 1-based line numbers; counts aggregate', () => {
  const r = redactText('clean\nAKIA1234567890ABCDEF\nAKIAABCDEFGHIJKLMNOP x');
  assert.deepStrictEqual(r.findings.map((f) => f.line), [2, 3]);
  assert.strictEqual(r.findings[0].pattern, 'AWS Access Key');
  assert.deepStrictEqual(r.counts, { 'AWS Access Key': 2 });
});

test('clean text passes through byte-identical', () => {
  const input = 'function hello(name) {\n  return `hi ${name}`;\n}\n';
  const r = redactText(input);
  assert.strictEqual(r.text, input);
  assert.strictEqual(r.redacted, false);
  assert.deepStrictEqual(r.findings, []);
});

// Regression #668: the Generic Secret pattern required a quoted value, so the
// common `.env` / YAML shape `password=value` passed through unmasked.
test('masks unquoted .env assignment (password=value)', () => {
  const r = redactText('password=SuperSecret123!');
  assert.strictEqual(r.text, '[REDACTED:Generic Secret]');
  assert.strictEqual(r.redacted, true);
});

test('masks unquoted assignment with an upper-case key (API_KEY=value)', () => {
  const r = redactText('API_KEY=abcd1234efgh');
  assert.strictEqual(r.text, '[REDACTED:Generic Secret]');
});

test('masks unquoted YAML assignment (password: value)', () => {
  const r = redactText('password: SuperSecret123!');
  assert.strictEqual(r.text, '[REDACTED:Generic Secret]');
});

test('quoted Generic Secret values are still masked', () => {
  const r = redactText('password="SuperSecret123!"');
  assert.strictEqual(r.text, '[REDACTED:Generic Secret]');
});

test('short, empty and non-secret lines stay untouched', () => {
  const untouched = [
    'password=x',
    'password=',
    'password=""',
    'password_hint=abcdefgh',
    'the password reset flow is documented',
    'export function hashPassword(password)',
  ];
  for (const line of untouched) {
    const r = redactText(line);
    assert.strictEqual(r.text, line, `expected untouched: ${line}`);
    assert.strictEqual(r.redacted, false, `expected no redaction: ${line}`);
  }
});

// ── #771: the credential shapes an AI-tooling repo actually contains ────────

// The reported reproduction: five of these seven passed through untouched.
test('#771 every credential shape in the report is redacted', () => {
  const lines = [
    `slack_bot ${'xo' + 'xb-'}2345678901-2345678901234-${AL.slice(0, 12)}`,
    `slack_webhook ${'https://hooks.' + 'slack.com'}/services/T00000000/B00000000/${AL.toUpperCase().slice(0, 20)}`,
    `openai ${'sk' + '-proj-'}${AL}${AL.toUpperCase().slice(0, 6)}`,
    `openai_legacy ${'sk' + '-'}${AL}${AL.toUpperCase().slice(0, 8)}`,
    `anthropic ${'sk' + '-ant-'}api03-${AL}${AL.slice(0, 6)}`,
    `aws ${'AK' + 'IA'}IOSFODNN7EXAMPLE`,
    'github ' + 'gh' + 'p_' + AL + '0123456789',
  ];
  const r = redactText(lines.join('\n'));
  assert.strictEqual(r.findings.length, 7,
    `expected all 7 lines redacted, got ${r.findings.length}: ${JSON.stringify(r.counts)}`);
  for (const line of r.text.split('\n')) {
    assert.ok(line.includes('[REDACTED:'), `line passed through unmasked: ${line}`);
  }
});

// `sk_live_` (underscore) was covered while `sk-` (hyphen) was not — the exact
// gap that let OpenAI and Anthropic keys through.
test('#771 sk- family is distinct from the sk_ Stripe pattern', () => {
  const stripe = redactText('sk_' + 'live_' + AL.slice(0, 24));
  assert.strictEqual(stripe.findings[0].pattern, 'Stripe Key', JSON.stringify(stripe.findings));
  const anthropic = redactText(`${'sk' + '-ant-'}api03-${AL}${AL.slice(0, 6)}`);
  assert.strictEqual(anthropic.findings[0].pattern, 'Anthropic API Key', JSON.stringify(anthropic.findings));
  const openai = redactText(`${'sk' + '-proj-'}${AL}${AL.toUpperCase().slice(0, 6)}`);
  assert.strictEqual(openai.findings[0].pattern, 'OpenAI API Key', JSON.stringify(openai.findings));
});

// A leading \b keeps `sk-` from matching inside an ordinary hyphenated word.
test('#771 sk- does not match inside a word like risk-', () => {
  for (const word of ['risk-', 'task-', 'desk-', 'brisk-']) {
    const r = redactText(`the ${word}${AL}${AL.toUpperCase().slice(0, 8)} assessment`);
    assert.strictEqual(r.redacted, false, `false positive on "${word}": ${r.text}`);
  }
});

// Regression #668/#680: the unquoted textOnly form must keep working.
test('#771 textOnly generic-secret behaviour is unchanged', () => {
  assert.strictEqual(redactText('password=SuperSecret123!').text, '[REDACTED:Generic Secret]');
  assert.strictEqual(redactText('api_key: SuperSecret123').text, '[REDACTED:Generic Secret]');
  assert.strictEqual(redactText('password: PasswordHasher').redacted, true);
  assert.strictEqual(redactText('function hello(name) { return name; }').redacted, false);
});

// #785's standing gate, asserted explicitly: a pattern with no fixture fails.
test('#785 every PATTERNS entry has a sample, and a new one without it fails', () => {
  for (const p of PATTERNS) {
    assert.ok(SAMPLES[p.name], `pattern "${p.name}" has no sample — the gate must fail here`);
  }
  const withUnsampled = PATTERNS.concat([{ name: 'Imaginary Future Key', regex: /zzz/ }]);
  const missing = withUnsampled.filter((p) => !SAMPLES[p.name]).map((p) => p.name);
  assert.deepStrictEqual(missing, ['Imaginary Future Key'],
    'an unsampled pattern must be detectable by the same rule the gate uses');
});

test('CLI redact <file>: stdout redacted, stderr summary', () => {
  const tmp = path.join(os.tmpdir(), `sigmap-redact-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'x AKIA1234567890ABCDEF y\n');
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'redact', tmp], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'x [REDACTED:AWS Access Key] y\n');
    assert.ok(r.stderr.includes('masked 1 secret'), r.stderr);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('CLI stdin + --json returns the result object', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'redact', '--json'],
    { encoding: 'utf8', input: `token ${'gh' + 'p_'}${AL}0123456789\n` });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.redacted, true);
  assert.deepStrictEqual(j.counts, { 'GitHub Token': 1 });
  assert.ok(j.text.includes('[REDACTED:GitHub Token]'));
});

test('CLI stdin masks an unquoted assignment', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'redact'],
    { encoding: 'utf8', input: 'password=SuperSecret123!\n' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '[REDACTED:Generic Secret]\n');
  assert.ok(r.stderr.includes('masked 1 secret'), r.stderr);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log(`[redact.test.js] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
