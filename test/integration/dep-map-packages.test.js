'use strict';

/**
 * Package visibility in the instruction file (#747 follow-up).
 *
 * Reported as "only npm projects write about the packages they use". Two
 * separate surfaces were responsible:
 *
 *   1. `## versions (installed direct deps)` resolves versions out of
 *      `node_modules`/`site-packages`, so it can only ever describe npm and
 *      Python. A Maven, Go, Cargo, Gem or Composer project got NOTHING — and
 *      an npm project without an install got nothing either.
 *   2. the `## deps` import map dropped bare specifiers, so a JS file's
 *      PACKAGES never appeared (only its relative wiring), and there was no
 *      Java mapping at all. `extractLuaDeps` existed, was exported, and was
 *      never called by anything.
 *
 * Run: node test/integration/dep-map-packages.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const GEN = path.join(ROOT, 'gen-context.js');
const { extractTSDeps, extractJavaDeps, extractLuaDeps } = require(path.join(ROOT, 'src', 'extractors', 'deps'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmap-depmap-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
const generate = (dir) => {
  execFileSync(process.execPath, [GEN], { cwd: dir, stdio: 'pipe' });
  return fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf8');
};
const section = (ctx, heading) => {
  const m = ctx.split('\n');
  const i = m.findIndex((l) => l.startsWith(heading));
  if (i === -1) return null;
  const body = [];
  for (let k = i + 1; k < m.length; k++) {
    if (m[k].startsWith('```')) { if (body.length) break; continue; }
    if (m[k].startsWith('## ')) break;
    body.push(m[k]);
  }
  return body.filter(Boolean).join('\n');
};

// ── 1. Declared dependencies reach the instruction file ─────────────────────

test('a Maven project lists its declared packages', () => {
  const dir = repo({
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion><artifactId>d</artifactId><version>1</version>'
      + '<dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>33.0.0-jre</version></dependency></dependencies></project>',
    'src/A.java': 'public class A {\n    public int f(int a) { return a; }\n}\n',
    'gen-context.config.json': JSON.stringify({ srcDirs: ['src'] }),
  });
  try {
    const dep = section(generate(dir), '## dependencies (declared');
    assert.ok(dep && /com\.google\.guava:guava@33\.0\.0-jre/.test(dep),
      `maven packages missing from the instruction file: ${dep}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Python project lists its requirements', () => {
  const dir = repo({
    'requirements.txt': 'fastapi==0.110.0\nrequests==2.31.0\n',
    'src/api.py': 'def f(a):\n    return a\n',
    'gen-context.config.json': JSON.stringify({ srcDirs: ['src'] }),
  });
  try {
    const dep = section(generate(dir), '## dependencies (declared');
    assert.ok(dep && /fastapi==0\.110\.0/.test(dep), `requirements missing: ${dep}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an npm project with no install still lists its packages', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { express: '^4.18.0' } }),
    'src/a.js': 'function f(a) { return a; }\nmodule.exports = { f };\n',
    'gen-context.config.json': JSON.stringify({ srcDirs: ['src'] }),
  });
  try {
    const dep = section(generate(dir), '## dependencies (declared');
    assert.ok(dep && /express@\^4\.18\.0/.test(dep), `npm packages missing without node_modules: ${dep}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the heading names the ecosystems, so the claim is checkable', () => {
  const dir = repo({
    'pom.xml': '<project><artifactId>d</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.0</version></dependency></dependencies></project>',
    'requirements.txt': 'flask==3.0.0\n',
    'src/a.py': 'def f():\n    return 1\n',
    'gen-context.config.json': JSON.stringify({ srcDirs: ['src'] }),
  });
  try {
    const ctx = generate(dir);
    const head = ctx.split('\n').find((l) => l.startsWith('## dependencies (declared'));
    assert.ok(/maven/.test(head) && /pypi/.test(head), `heading should name both ecosystems: ${head}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('`versionPins: false` still suppresses the section', () => {
  const dir = repo({
    'pom.xml': '<project><artifactId>d</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.0</version></dependency></dependencies></project>',
    'src/A.java': 'public class A { public int f() { return 1; } }\n',
    'gen-context.config.json': JSON.stringify({ srcDirs: ['src'], versionPins: false }),
  });
  try {
    assert.strictEqual(section(generate(dir), '## dependencies (declared'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 2. The import map sees packages, and sees Java ──────────────────────────

test('extractTSDeps returns package names, not only relative paths', () => {
  const got = extractTSDeps("const express = require('express');\nimport axios from 'axios';\nimport {x} from './util';\n");
  assert.ok(got.includes('express'), `require() package missing: ${got}`);
  assert.ok(got.includes('axios'), `import package missing: ${got}`);
  assert.ok(got.includes('util'), `relative import lost: ${got}`);
});

test('a scoped package keeps its scope and drops the subpath', () => {
  const got = extractTSDeps("import y from '@scope/pkg/sub/deep';\n");
  assert.deepStrictEqual(got, ['@scope/pkg']);
});

test('node: builtins and absolute specifiers are not packages', () => {
  const got = extractTSDeps("import fs from 'node:fs';\nimport a from '/abs/path';\n");
  assert.deepStrictEqual(got, []);
});

test('a commented-out import is still ignored', () => {
  const got = extractTSDeps("// import ghost from 'ghost-pkg';\nimport real from 'real-pkg';\n");
  assert.deepStrictEqual(got, ['real-pkg']);
});

test('extractJavaDeps reduces an import to its package', () => {
  const got = extractJavaDeps('import com.fasterxml.jackson.databind.ObjectMapper;\n');
  assert.deepStrictEqual(got, ['com.fasterxml.jackson.databind']);
});

test('extractJavaDeps skips the Java platform', () => {
  const got = extractJavaDeps('import java.util.List;\nimport javax.sql.DataSource;\nimport org.x.Y;\n');
  assert.deepStrictEqual(got, ['org.x']);
});

test('a static import resolves to the same package', () => {
  const got = extractJavaDeps('import static org.junit.jupiter.api.Assertions.assertEquals;\n');
  assert.deepStrictEqual(got, ['org.junit.jupiter.api']);
});

test('the import map covers java, python and js in one repo', () => {
  const dir = repo({
    'src/App.java': 'import com.fasterxml.jackson.databind.ObjectMapper;\npublic class App { public int f() { return 1; } }\n',
    'src/api.py': 'from fastapi import FastAPI\n\ndef h(a):\n    return a\n',
    'src/server.js': "const express = require('express');\nfunction s(a) { return a; }\nmodule.exports = { s };\n",
    'gen-context.config.json': JSON.stringify({ srcDirs: ['src'], depMap: true }),
  });
  try {
    const deps = section(generate(dir), '## deps');
    assert.ok(/App\.java ← com\.fasterxml/.test(deps), `java row missing: ${deps}`);
    assert.ok(/api\.py ← fastapi/.test(deps), `python row missing: ${deps}`);
    assert.ok(/server\.js ← express/.test(deps), `js package row missing: ${deps}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractLuaDeps is reachable — it was exported but never called', () => {
  assert.ok(typeof extractLuaDeps === 'function');
  const src = fs.readFileSync(path.join(ROOT, 'gen-context.js'), 'utf8');
  assert.ok(/extractLuaDeps\s*\?\s*extractLuaDeps\(content\)/.test(src),
    'gen-context still never dispatches .lua to extractLuaDeps');
});

console.log(`\n  dep-map-packages: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
