'use strict';

/**
 * Kotlin and Scala produce call-graph definitions and edges (#586).
 *
 * `extractDefs` returned null for `.kt`/`.scala`, and the walk did not collect
 * them at all, so the graph was EMPTY for those languages — and an empty graph
 * returns no error. `--impact` and blast radius silently degenerated to zero,
 * which is exactly the failure that cost a release in #561. akka (Scala) is in
 * the gated JVM retrieval corpus, so CI exercised Scala in a way that could
 * never detect this.
 *
 * Scope is deliberately pinned below: unqualified (same-file) calls resolve;
 * cross-file RECEIVER calls (`repo.findAll()`) do not yet, because receiver
 * typing is Java-shaped (`private Repo repo;`) and does not understand
 * `private val repo: Repo` or a Scala constructor parameter. The assertion
 * records that limit so a future fix flips it deliberately rather than by
 * accident.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { extractDefs, buildCallGraph } = require(path.join(ROOT, 'src/graph/call-graph'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const names = (defs) => (defs || []).map((d) => d.name).sort();

test('Kotlin fun definitions are extracted', () => {
  const src = [
    'package x',
    'class S(private val repo: R) {',
    '    fun findAll(): List<V> {',
    '        return repo.all()',
    '    }',
    '    suspend fun loadAsync(id: Int): V? {',
    '        return repo.byId(id)',
    '    }',
    '}',
  ].join('\n');
  assert.deepStrictEqual(names(extractDefs('S.kt', src)), ['findAll', 'loadAsync']);
});

test('Kotlin expression bodies count as definitions', () => {
  const src = 'package x\nclass S(private val repo: R) {\n    fun save(v: V) = repo.put(v)\n}';
  assert.deepStrictEqual(names(extractDefs('S.kt', src)), ['save']);
});

test('Kotlin extension functions are recorded by member name', () => {
  const src = 'package x\nfun String.shout(): String {\n    return this\n}';
  assert.deepStrictEqual(names(extractDefs('E.kt', src)), ['shout']);
});

test('Scala def definitions are extracted, including parameterless', () => {
  const src = [
    'package x',
    'class S(repo: R) {',
    '  def findAll(): List[V] = {',
    '    repo.all()',
    '  }',
    '  def count: Int = repo.size',
    '}',
  ].join('\n');
  assert.deepStrictEqual(names(extractDefs('S.scala', src)), ['count', 'findAll']);
});

test('.kts and .sc dispatch too', () => {
  assert.deepStrictEqual(names(extractDefs('build.kts', 'fun cfg() {\n}')), ['cfg']);
  assert.deepStrictEqual(names(extractDefs('s.sc', 'def cfg(): Unit = {\n}')), ['cfg']);
});

// ── End-to-end: the graph is no longer empty ───────────────────────────────

function jvmRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-ktsc-'));
  const kt = path.join(dir, 'src', 'main', 'kotlin', 'com', 'acme');
  const sc = path.join(dir, 'src', 'main', 'scala', 'com', 'acme');
  fs.mkdirSync(kt, { recursive: true });
  fs.mkdirSync(sc, { recursive: true });
  fs.writeFileSync(path.join(kt, 'Util.kt'),
    'package com.acme\nclass Util {\n    fun outer(a: String): String {\n        return inner(a)\n    }\n    fun inner(a: String): String {\n        return a\n    }\n}\n');
  fs.writeFileSync(path.join(sc, 'Logging.scala'),
    'package com.acme\nclass Logging {\n  def warn(m: String): Unit = {\n    emit(m)\n  }\n  def emit(m: String): Unit = {\n  }\n}\n');
  fs.writeFileSync(path.join(dir, 'gen-context.config.json'), JSON.stringify({ srcDirs: ['src'] }));
  return dir;
}

test('the call graph indexes Kotlin and Scala symbols', () => {
  const g = buildCallGraph(jvmRepo());
  assert.ok(g.forward.size >= 4,
    `expected Kotlin+Scala symbols in the graph, got ${g.forward.size}`);
});

test('same-file calls produce edges in both languages', () => {
  const g = buildCallGraph(jvmRepo());
  const edges = [];
  for (const [from, tos] of g.forward) for (const to of tos) edges.push(`${from} -> ${to}`);
  assert.ok(edges.some((e) => /Util\.kt#outer .*Util\.kt#inner/.test(e)),
    `no Kotlin same-file edge among: ${edges.join(' | ')}`);
  assert.ok(edges.some((e) => /Logging\.scala#warn .*Logging\.scala#emit/.test(e)),
    `no Scala same-file edge among: ${edges.join(' | ')}`);
});

test('documents the limit: cross-file receiver calls are not resolved yet', () => {
  // Receiver typing is Java-shaped and does not read `private val repo: R`.
  // If this ever starts passing, the limit was fixed — update this test and
  // the KNOWN gap rather than deleting the assertion silently.
  const dir = jvmRepo();
  const kt = path.join(dir, 'src', 'main', 'kotlin', 'com', 'acme');
  fs.writeFileSync(path.join(kt, 'Repo.kt'),
    'package com.acme\nclass Repo {\n    fun findAll(): List<String> {\n        return listOf()\n    }\n}\n');
  fs.writeFileSync(path.join(kt, 'Svc.kt'),
    'package com.acme\nclass Svc(private val repo: Repo) {\n    fun list(): List<String> {\n        return repo.findAll()\n    }\n}\n');
  const g = buildCallGraph(dir);
  const edges = [];
  for (const [from, tos] of g.forward) for (const to of tos) edges.push(`${from} -> ${to}`);
  const crossFile = edges.some((e) => /Svc\.kt#list .*Repo\.kt#findAll/.test(e));
  assert.strictEqual(crossFile, false,
    'cross-file receiver calls now resolve for Kotlin — good; update this test and close the gap');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
