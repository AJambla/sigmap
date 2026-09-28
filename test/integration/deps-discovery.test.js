'use strict';

/**
 * Dependency-manifest discovery and Maven parsing (#747).
 *
 * Four defects, all reproducible on a clean checkout:
 *
 *   1. manifests were probed at the repo ROOT only, so a multi-module Maven
 *      build — the normal shape for Java — reported "(none declared)" while
 *      every dependency sat in `service-<name>/pom.xml`
 *   2. `<parent>` shadowed the project's own identity, so every Spring Boot POM
 *      reported `spring-boot-starter-parent` as the project
 *   3. `<dependencyManagement>` version constraints were counted as real
 *      dependencies, inflating counts and leaking into `sigmap sbom`
 *   4. Maven scope collapsed to runtime/test, so `provided` — compile-time only
 *      and NOT shipped — was indistinguishable from a runtime dependency
 *
 * Run: node test/integration/deps-discovery.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const { collectDependencies, findManifests } = require(path.join(ROOT, 'src', 'deps', 'inventory'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-deps-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
const POM = (inner) => `<project><modelVersion>4.0.0</modelVersion>${inner}</project>`;
const names = (inv) => inv.deps.map((d) => d.name);

// ── 1. Nested discovery ──────────────────────────────────────────────────────

test('a multi-module Maven build reports every module\'s dependencies', () => {
  const dir = tmp({
    'pom.xml': POM('<groupId>c</groupId><artifactId>root</artifactId><version>1.0.0</version><modules><module>api</module></modules>'),
    'api/pom.xml': POM('<artifactId>api</artifactId><dependencies><dependency><groupId>io.grpc</groupId><artifactId>grpc-stub</artifactId><version>1.62.2</version></dependency></dependencies>'),
    'core/pom.xml': POM('<artifactId>core</artifactId><dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>33.0.0-jre</version></dependency></dependencies>'),
  });
  try {
    const inv = collectDependencies(dir);
    assert.ok(names(inv).includes('io.grpc:grpc-stub'), `grpc missing: ${names(inv)}`);
    assert.ok(names(inv).includes('com.google.guava:guava'), `guava missing: ${names(inv)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a nested requirements.txt is found', () => {
  const dir = tmp({ 'pom.xml': POM('<artifactId>r</artifactId>'), 'backend/requirements.txt': 'django==5.0\n' });
  try {
    assert.ok(names(collectDependencies(dir)).includes('django'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('each manifest is reported with its own path', () => {
  const dir = tmp({
    'pom.xml': POM('<artifactId>root</artifactId>'),
    'api/pom.xml': POM('<artifactId>api</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1</version></dependency></dependencies>'),
  });
  try {
    const files = collectDependencies(dir).manifests.map((m) => m.file);
    assert.ok(files.includes('api/pom.xml'), `expected api/pom.xml, got ${JSON.stringify(files)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the walk skips build output and vendored trees', () => {
  const dir = tmp({
    'package.json': '{"name":"x","version":"1.0.0"}',
    'node_modules/dep/package.json': '{"name":"dep","dependencies":{"ghost":"1.0.0"}}',
    'target/pom.xml': POM('<artifactId>t</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>ghost2</artifactId><version>1</version></dependency></dependencies>'),
  });
  try {
    const n = names(collectDependencies(dir));
    assert.ok(!n.some((x) => /ghost/.test(x)), `descended into an excluded tree: ${n}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the walk honours the project\'s own exclude config', () => {
  // sigmap's benchmarks/repos holds 43 cloned third-party repos; every one of
  // their manifests was being reported as a sigmap dependency.
  const dir = tmp({
    'package.json': '{"name":"x","version":"1.0.0"}',
    'gen-context.config.json': JSON.stringify({ exclude: ['vendored'] }),
    'vendored/other/package.json': '{"name":"other","dependencies":{"ghost":"1.0.0"}}',
  });
  try {
    assert.ok(!names(collectDependencies(dir)).includes('ghost'),
      'a config-excluded directory was walked');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fixture trees are not mistaken for project manifests', () => {
  const dir = tmp({
    'package.json': '{"name":"x","version":"1.0.0"}',
    'test/fixtures/pom.xml': POM('<artifactId>fixture</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>fixture-only</artifactId><version>1</version></dependency></dependencies>'),
  });
  try {
    assert.ok(!names(collectDependencies(dir)).includes('g:fixture-only'),
      'a fixture manifest was reported as a real dependency');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the walk is bounded and returns a deterministic order', () => {
  const files = { 'package.json': '{"name":"x","version":"1.0.0"}' };
  files['a/b/c/d/e/f/pom.xml'] = POM('<artifactId>deep</artifactId>');
  const dir = tmp(files);
  try {
    const found = findManifests(dir);
    assert.ok(!found.includes('a/b/c/d/e/f/pom.xml'), 'walk exceeded its depth bound');
    assert.deepStrictEqual(found, found.slice().sort((a, b) => {
      const da = a.split('/').length, db = b.split('/').length;
      return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0;
    }), 'order must be root-first then path-stable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 2–4. Maven parsing ───────────────────────────────────────────────────────

test('a POM with a <parent> reports its OWN identity', () => {
  const dir = tmp({
    'pom.xml': POM('<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.0</version></parent>'
      + '<groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version>'),
  });
  try {
    const m = collectDependencies(dir).manifests.find((x) => x.file === 'pom.xml');
    assert.strictEqual(m.name, 'demo', `identity taken from <parent>: ${m.name}`);
    assert.strictEqual(m.version, '1.0.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a child POM inherits the parent version when it declares none', () => {
  const dir = tmp({
    'pom.xml': POM('<parent><groupId>g</groupId><artifactId>p</artifactId><version>2.5.0</version></parent><artifactId>child</artifactId>'),
  });
  try {
    const m = collectDependencies(dir).manifests.find((x) => x.file === 'pom.xml');
    assert.strictEqual(m.name, 'child');
    assert.strictEqual(m.version, '2.5.0', 'should fall back to the parent version, as Maven does');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('<dependencyManagement> entries are not reported as dependencies', () => {
  const dir = tmp({
    'pom.xml': POM('<artifactId>d</artifactId>'
      + '<dependencyManagement><dependencies><dependency><groupId>io.managed</groupId><artifactId>managed-only</artifactId><version>9.9.9</version></dependency></dependencies></dependencyManagement>'
      + '<dependencies><dependency><groupId>real</groupId><artifactId>dep</artifactId><version>1</version></dependency></dependencies>'),
  });
  try {
    const n = names(collectDependencies(dir));
    assert.ok(!n.includes('io.managed:managed-only'), 'a version constraint was reported as a dependency');
    assert.ok(n.includes('real:dep'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provided is distinguishable from runtime', () => {
  const dir = tmp({
    'pom.xml': POM('<artifactId>d</artifactId><dependencies>'
      + '<dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>1.18.30</version><scope>provided</scope></dependency>'
      + '<dependency><groupId>g</groupId><artifactId>rt</artifactId><version>1</version></dependency>'
      + '<dependency><groupId>g</groupId><artifactId>t</artifactId><version>1</version><scope>test</scope></dependency>'
      + '</dependencies>'),
  });
  try {
    const by = Object.fromEntries(collectDependencies(dir).deps.map((d) => [d.name, d.scope]));
    assert.strictEqual(by['org.projectlombok:lombok'], 'build', 'provided must not read as runtime — it is not shipped');
    assert.strictEqual(by['g:rt'], 'runtime');
    assert.strictEqual(by['g:t'], 'test');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a <scope>import</scope> BOM pointer is not a dependency', () => {
  const dir = tmp({
    'pom.xml': POM('<artifactId>d</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>bom</artifactId><version>1</version><type>pom</type><scope>import</scope></dependency></dependencies>'),
  });
  try {
    assert.ok(!names(collectDependencies(dir)).includes('g:bom'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('${property} placeholders still resolve', () => {
  const dir = tmp({
    'pom.xml': POM('<artifactId>d</artifactId><properties><jackson.version>2.17.1</jackson.version></properties>'
      + '<dependencies><dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>${jackson.version}</version></dependency></dependencies>'),
  });
  try {
    const d = collectDependencies(dir).deps.find((x) => x.name === 'com.fasterxml.jackson.core:jackson-databind');
    assert.strictEqual(d.version, '2.17.1', 'placeholder left unresolved');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a commented-out <dependency> is still ignored', () => {
  const dir = tmp({
    'pom.xml': POM('<artifactId>d</artifactId><dependencies><!-- <dependency><groupId>ghost</groupId><artifactId>g</artifactId><version>1</version></dependency> -->'
      + '<dependency><groupId>real</groupId><artifactId>r</artifactId><version>1</version></dependency></dependencies>'),
  });
  try {
    const n = names(collectDependencies(dir));
    assert.ok(!n.includes('ghost:g'));
    assert.ok(n.includes('real:r'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n  deps-discovery: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
