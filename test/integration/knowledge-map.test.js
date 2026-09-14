'use strict';

/**
 * Unified knowledge map, increment 1 (#626, #543): typed nodes/edges from
 * existing producers, deterministic serialization, and the epic's headline
 * query — "what breaks if I upgrade <lib>": lib → importing files → their
 * callers → the tests covering the blast set.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'gen-context.js');
const km = require(path.join(ROOT, 'src/map/knowledge-map'));
const { queryKnowledgeMap } = require(path.join(ROOT, 'src/mcp/handlers'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

/**
 * Fixture: a declared+installed dep (leftpad, faked in node_modules), a file
 * importing it, a caller of that file, and a test covering the caller chain.
 */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-km-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'leftpad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'km-fixture', version: '1.0.0', dependencies: { leftpad: '^9.1.0' },
    scripts: { lint: 'true' },
  }));
  fs.writeFileSync(path.join(dir, '.env.example'), 'PAD_WIDTH=8\nUNUSED_FLAG=0\n');
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'migrations', '20240101120000_create_pads.sql'), 'CREATE TABLE pads (id int);\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'leftpad', 'package.json'), JSON.stringify({
    name: 'leftpad', version: '9.1.4', main: 'index.js',
  }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'leftpad', 'index.js'), 'module.exports = (s) => s;\n');
  fs.writeFileSync(path.join(dir, 'src', 'pad.js'),
    "const leftpad = require('leftpad');\nconst WIDTH = process.env.PAD_WIDTH;\nfunction padded(s) {\n  return leftpad(s, WIDTH);\n}\nmodule.exports = { padded };\n");
  fs.writeFileSync(path.join(dir, 'src', 'banner.js'),
    "const { padded } = require('./pad');\nfunction banner(text) {\n  return padded(text);\n}\nmodule.exports = { banner };\n");
  fs.writeFileSync(path.join(dir, 'test', 'banner.test.js'),
    "const { banner } = require('../src/banner');\nfunction checkBanner() {\n  return banner('x');\n}\nmodule.exports = { checkBanner };\n");
  fs.writeFileSync(path.join(dir, 'src', 'app.js'),
    "const express = require('express');\nconst app = express();\napp.get('/pad/:id', (req, res) => {\n  res.send(req.params.id);\n});\nmodule.exports = { app };\n");
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({
    srcDirs: ['src', 'test'], changes: false,
  }));
  execFileSync('node', [CLI], { cwd: dir, stdio: 'pipe' });
  return dir;
}

const dir = repo();
const map = km.buildKnowledgeMap(dir);

test('two consecutive builds are byte-identical (determinism)', () => {
  const again = km.buildKnowledgeMap(dir);
  assert.strictEqual(km.canonicalJson(map), km.canonicalJson(again));
});

test('typed nodes: files, symbols with anchors, and the pinned library', () => {
  const kinds = new Set(map.nodes.map((n) => n.kind));
  assert.ok(kinds.has('file') && kinds.has('symbol'), `missing kinds: ${[...kinds]}`);
  const lib = map.nodes.find((n) => n.kind === 'library');
  assert.ok(lib, 'library node missing');
  assert.strictEqual(lib.id, 'lib:leftpad@9.1.4', `installed version must pin the node id: ${lib.id}`);
  const sym = map.nodes.find((n) => n.id === 'symbol:src/pad.js#padded');
  assert.ok(sym && sym.anchor, `symbol with anchor missing: ${JSON.stringify(sym)}`);
});

test('edges: uses-lib, imports, defines, tests all present', () => {
  const kinds = new Set(map.edges.map((e) => e.kind));
  for (const k of ['uses-lib', 'imports', 'defines', 'tests']) {
    assert.ok(kinds.has(k), `edge kind ${k} missing (have: ${[...kinds]})`);
  }
  assert.ok(map.edges.some((e) => e.from === 'file:src/pad.js' && e.kind === 'uses-lib' && e.to === 'lib:leftpad@9.1.4'));
  assert.ok(map.edges.some((e) => e.from === 'file:src/banner.js' && e.kind === 'imports' && e.to === 'file:src/pad.js'));
});

test('route ids with spaces survive edge serialization', () => {
  const route = map.nodes.find((n) => n.kind === 'route');
  assert.ok(route, 'route node missing — expected app.get to register');
  const edge = map.edges.find((e) => e.kind === 'exposes-route');
  assert.ok(edge && edge.to === route.id && edge.to.includes(' '),
    `route edge mangled: ${JSON.stringify(edge)} vs ${route.id}`);
});

test('upgrade impact walks lib → importers → callers → tests', () => {
  const impact = km.upgradeImpact(map, 'leftpad');
  assert.ok(impact, 'no impact result');
  assert.deepStrictEqual(impact.importers, ['file:src/pad.js']);
  assert.ok(impact.callers.includes('file:src/banner.js'), `callers: ${impact.callers}`);
  assert.ok(impact.tests.includes('file:test/banner.test.js'), `tests: ${impact.tests}`);
});

test('MCP handler renders the chain and the neighbors view', () => {
  const out = queryKnowledgeMap({ library: 'leftpad' }, dir);
  assert.ok(out.includes('lib:leftpad@9.1.4'), out.slice(0, 120));
  assert.ok(out.includes('src/pad.js') && out.includes('src/banner.js') && out.includes('test/banner.test.js'));
  const neighbors = queryKnowledgeMap({ file: 'src/pad.js' }, dir);
  assert.ok(neighbors.includes('importedBy') && neighbors.includes('usesLibs'), neighbors.slice(0, 160));
  const summary = queryKnowledgeMap({}, dir);
  assert.ok(/schema v2 · \d+ nodes · \d+ edges/.test(summary), summary);
});

test('env-var nodes carry the example flag and per-file reads-env edges', () => {
  const envNode = map.nodes.find((n) => n.id === 'env:PAD_WIDTH');
  assert.ok(envNode && envNode.kind === 'env-var' && envNode.inExample === true,
    `PAD_WIDTH node wrong: ${JSON.stringify(envNode)}`);
  assert.ok(map.edges.some((e) => e.from === 'file:src/pad.js' && e.kind === 'reads-env' && e.to === 'env:PAD_WIDTH'),
    'reads-env edge missing for src/pad.js → PAD_WIDTH');
  const unused = map.nodes.find((n) => n.id === 'env:UNUSED_FLAG');
  assert.ok(unused && unused.inExample === true, 'example-only var must still get a node');
  assert.ok(!map.edges.some((e) => e.kind === 'reads-env' && e.to === 'env:UNUSED_FLAG'),
    'example-only var must have no reader edges');
});

test('migration and script nodes from the structured collectors', () => {
  const mig = map.nodes.find((n) => n.kind === 'migration');
  assert.ok(mig && mig.id === 'migration:migrations/20240101120000_create_pads.sql'
    && mig.version === '20240101120000', `migration node wrong: ${JSON.stringify(mig)}`);
  const script = map.nodes.find((n) => n.id === 'script:script:lint');
  assert.ok(script && script.runner === 'script' && script.detail === 'npm run lint',
    `script node wrong: ${JSON.stringify(script)}`);
});

test('MCP env query renders readers and the example-declaration status', () => {
  const out = queryKnowledgeMap({ env: 'PAD_WIDTH' }, dir);
  assert.ok(out.includes('env:PAD_WIDTH') && out.includes('declared in a committed .env example: yes')
    && out.includes('src/pad.js'), out);
  const miss = queryKnowledgeMap({ env: 'NOPE_VAR' }, dir);
  assert.ok(miss.startsWith('No env-var node'), miss);
});

test('fileNeighbors exposes readsEnv', () => {
  const n = km.fileNeighbors(map, 'src/pad.js');
  assert.deepStrictEqual(n.readsEnv, ['env:PAD_WIDTH']);
});

test('schema bump invalidates a v1 cache', () => {
  const cachePath = path.join(dir, '.context', 'knowledge-map.json');
  km.loadOrBuild(dir); // populate, then poison with a v1 shell keyed to the same mtime
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  fs.writeFileSync(cachePath, JSON.stringify({ schema: 1, nodes: [], edges: [], truncated: [], builtFor: cached.builtFor }));
  const rebuilt = km.loadOrBuild(dir);
  assert.strictEqual(rebuilt.schema, 2);
  assert.ok(rebuilt.nodes.length > 0, 'stale v1 cache must be rebuilt, not served');
});

test('producer analyze output derives from the collectors (env table rows)', () => {
  const envSchema = require(path.join(ROOT, 'src/map/env-schema'));
  const absFiles = ['src/pad.js', 'src/banner.js', 'src/app.js', 'test/banner.test.js'].map((r) => path.join(dir, r));
  const table = envSchema.analyze(absFiles, dir);
  assert.ok(table.includes('| PAD_WIDTH | code, .env.example |'), table);
  assert.ok(table.includes('| UNUSED_FLAG | .env.example |'), table);
  const rows = envSchema.collectEnvReads(absFiles, dir);
  assert.deepStrictEqual(rows.find((r) => r.name === 'PAD_WIDTH').files, ['src/pad.js']);
});

test('knowledge-map.js source is NUL-free so git diffs it as text', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/map/knowledge-map.js'));
  assert.ok(!src.includes(0), 'raw NUL bytes make git treat the file as binary');
});

test('the store persists to .context and cache-hits on unchanged context', () => {
  const first = km.loadOrBuild(dir);
  const cachePath = path.join(dir, '.context', 'knowledge-map.json');
  assert.ok(fs.existsSync(cachePath), 'cache file missing');
  const second = km.loadOrBuild(dir);
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
