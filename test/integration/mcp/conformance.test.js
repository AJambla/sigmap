'use strict';

/**
 * MCP spec-conformance regressions (#544, #545), pinned from the
 * @hasmcp/mcp-spec-test findings.
 *
 * #544 (spec 2025-11-25): the server echoed back ANY protocol version a
 * client offered — including versions it cannot speak — instead of refusing
 * or downgrading. #545 (spec 2026-07-28) was a downstream consequence: the
 * echo made the conformance suite believe 2026-07-28 was supported, so it
 * tested that revision and filed six phantom server/discover violations.
 *
 * The fix negotiates honestly (unsupported offer → newest supported version,
 * never an echo) and answers session-less `server/discover` with the honest
 * version list, per the 2026-07-28 schema's DiscoverResult (required:
 * cacheScope, capabilities, resultType, supportedVersions, ttlMs).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const GEN_CONTEXT = path.resolve(__dirname, '../../../gen-context.js');
const NEWEST_SUPPORTED = '2025-11-25';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}: ${err.message}`); failed++; }
}

function mcpCall(messages, cwd) {
  const input = (Array.isArray(messages) ? messages : [messages])
    .map((m) => JSON.stringify(m)).join('\n') + '\n';
  const stdout = execSync(`node "${GEN_CONTEXT}" --mcp`, { input, cwd, encoding: 'utf8', timeout: 10000 });
  return stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-mcp-conf-'));

console.log('[mcp/conformance.test.js] #544/#545 spec-conformance regressions');
console.log('');

test('an unsupported offered version is downgraded, not echoed (#544)', () => {
  const [res] = mcpCall(
    { jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2099-01-01', capabilities: {} } },
    dir
  );
  assert.strictEqual(res.result.protocolVersion, NEWEST_SUPPORTED,
    `echoed/returned ${res.result.protocolVersion} for an unspeakable offer`);
});

test('2026-07-28 is not claimed at the handshake (it is not served)', () => {
  const [res] = mcpCall(
    { jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2026-07-28', capabilities: {} } },
    dir
  );
  assert.strictEqual(res.result.protocolVersion, NEWEST_SUPPORTED,
    `claimed ${res.result.protocolVersion}; server/discover & result envelopes are not implemented for it`);
});

test('a supported offered version is accepted as offered', () => {
  for (const v of ['2024-11-05', NEWEST_SUPPORTED]) {
    const [res] = mcpCall(
      { jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: v, capabilities: {} } },
      dir
    );
    assert.strictEqual(res.result.protocolVersion, v, `offer ${v} → ${res.result.protocolVersion}`);
  }
});

test('a version-less client gets the newest supported version', () => {
  const [res] = mcpCall(
    { jsonrpc: '2.0', method: 'initialize', id: 1, params: { capabilities: {} } },
    dir
  );
  assert.strictEqual(res.result.protocolVersion, NEWEST_SUPPORTED);
});

test('server/discover answers without a handshake, schema-complete (#545)', () => {
  const [res] = mcpCall(
    { jsonrpc: '2.0', method: 'server/discover', id: 1, params: {} },
    dir
  );
  const out = res.result;
  assert.ok(out, `expected a result, got ${JSON.stringify(res)}`);
  // The 2026-07-28 schema's required DiscoverResult fields:
  for (const field of ['cacheScope', 'capabilities', 'resultType', 'supportedVersions', 'ttlMs']) {
    assert.ok(field in out, `DiscoverResult is missing schema-required field: ${field}`);
  }
  assert.strictEqual(out.resultType, 'complete');
  assert.ok(['public', 'private'].includes(out.cacheScope));
  assert.ok(typeof out.ttlMs === 'number' && out.ttlMs >= 0);
  assert.ok(out.serverInfo && out.serverInfo.name, 'the identity check needs a named serverInfo');
});

test('discover advertises only versions the server actually speaks', () => {
  const [res] = mcpCall({ jsonrpc: '2.0', method: 'server/discover', id: 1, params: {} }, dir);
  const versions = res.result.supportedVersions;
  assert.ok(Array.isArray(versions) && versions.length > 0);
  for (const v of versions) {
    assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `"${v}" is not a protocol revision date`);
    assert.notStrictEqual(v, '2026-07-28', 'advertising 2026-07-28 without serving its surface re-creates #545');
  }
  assert.ok(versions.includes(NEWEST_SUPPORTED),
    'the version negotiated for a version-less client must itself be advertised');
});

test('discover is stable across calls (the TTL promise holds)', () => {
  const [a] = mcpCall({ jsonrpc: '2.0', method: 'server/discover', id: 1, params: {} }, dir);
  const [b] = mcpCall({ jsonrpc: '2.0', method: 'server/discover', id: 1, params: {} }, dir);
  assert.deepStrictEqual(a.result, b.result);
});

test('tools/list rejects a cursor it never issued (-32602, spec SHOULD)', () => {
  const [res] = mcpCall(
    { jsonrpc: '2.0', method: 'tools/list', id: 1, params: { cursor: 'not-a-cursor' } },
    dir
  );
  assert.ok(res.error, `expected an error, got a result with ${res.result && res.result.tools.length} tools`);
  assert.strictEqual(res.error.code, -32602);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
