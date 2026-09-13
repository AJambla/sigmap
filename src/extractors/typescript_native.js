'use strict';

const path = require('path');
const { anchor } = require('./line-anchor');
const { capWithNotice, capMembersWithNotice } = require('../util/truncate');

// True-AST TypeScript extraction via the TARGET REPO's own `typescript`
// package (#609, tier T2 of #542). Nothing is bundled and nothing is
// required to exist: `resolveRepoTypescript` probes node_modules upward from
// the file being extracted — the user's install, never ours (the lib-index
// precedent) — and every failure path returns null so the caller falls back
// to the regex extractor silently. Opt-in via `exactness.typescript`; the
// resolved compiler is the target repo's own code and runs in-process, which
// is why this tier is a conscious config choice rather than a default.
//
// Output parity: same line vocabulary as src/extractors/typescript.js (the
// regex floor), same ceilings, same disclosure markers — only the parse is
// different, so anchors and signatures survive multiline declarations,
// constrained generics, decorators, and overloads that regex cannot see.

// Emit only what the regex tier emits, in the same kind-grouped order, so a
// flag-on/flag-off diff shows parsing differences rather than reordering.
const MEMBER_LIMIT = 120;
const PER_FILE_LIMIT = 200;
const FUNC_RET_CHARS = 30;
const METHOD_RET_CHARS = 20;
const IFACE_TYPE_CHARS = 35;

const _resolveCache = new Map(); // dirname → { ts, version } | null

/**
 * Resolve the target repo's own `typescript` package, walking node_modules
 * upward from the file's directory. Cached per directory; null when absent
 * or unloadable.
 * @param {string} fromPath - absolute path of the file being extracted
 * @returns {{ ts: object, version: string }|null}
 */
function resolveRepoTypescript(fromPath) {
  const dir = path.dirname(path.resolve(fromPath));
  if (_resolveCache.has(dir)) return _resolveCache.get(dir);
  let out = null;
  try {
    const resolved = require.resolve('typescript', { paths: [dir] });
    const ts = require(resolved);
    if (ts && typeof ts.createSourceFile === 'function' && typeof ts.version === 'string') {
      out = { ts, version: ts.version };
    }
  } catch (_) {}
  _resolveCache.set(dir, out);
  return out;
}

const _compact = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Extract signatures from TypeScript source via the provided compiler module.
 * Returns null on ANY failure so the caller can fall back to regex.
 * @param {string} src - raw file content
 * @param {string} filePath - absolute path (names the SourceFile)
 * @param {object} ts - a resolved `typescript` module
 * @returns {string[]|null}
 */
function extract(src, filePath, ts) {
  if (!src || typeof src !== 'string' || !ts) return null;
  try {
    return _extract(src, filePath, ts);
  } catch (_) {
    return null;
  }
}

function _extract(src, filePath, ts) {
  const sf = ts.createSourceFile(filePath || 'file.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const startLine = (node) => lineOf(node.getStart(sf));
  const endLine = (node) => lineOf(node.end > 0 ? node.end - 1 : node.end);
  const mods = (node) => (ts.canHaveModifiers && ts.canHaveModifiers(node) ? ts.getModifiers(node) : node.modifiers) || [];
  const hasMod = (node, kind) => mods(node).some((m) => m.kind === kind);
  const isExported = (node) => hasMod(node, ts.SyntaxKind.ExportKeyword);

  // Parameter rendering matches normalizeParams' output: names and defaults
  // survive, type annotations do not; constructor parameter-property
  // modifiers (private/readonly/...) survive because they name real fields.
  const paramText = (p) => {
    let out = '';
    for (const m of mods(p)) out += m.getText(sf) + ' ';
    if (p.dotDotDotToken) out += '...';
    out += _compact(p.name.getText(sf));
    if (p.initializer) out += ` = ${_compact(p.initializer.getText(sf)).slice(0, 40)}`;
    return out;
  };
  const paramsText = (node) => (node.parameters || []).map(paramText).join(', ');
  const retText = (node, cap) => {
    if (!node.type) return '';
    const t = _compact(node.type.getText(sf)).slice(0, cap);
    return t ? ` → ${t}` : '';
  };
  const docHint = (node) => {
    const js = node.jsDoc && node.jsDoc[0];
    if (!js || !js.comment) return '';
    const text = typeof js.comment === 'string'
      ? js.comment
      : js.comment.map((c) => c.text || '').join('');
    return _compact(text).split(/[.!?]/)[0].trim().slice(0, 60);
  };

  const interfaces = [];
  const types = [];
  const enums = [];
  const classes = [];
  const funcs = [];
  const arrows = [];

  for (const node of sf.statements) {
    if (ts.isInterfaceDeclaration(node) && isExported(node)) {
      const block = [{ text: `export interface ${node.name.text}`, s: startLine(node), e: endLine(node) }];
      const members = [];
      for (const mem of node.members) {
        if (ts.isPropertySignature(mem) && mem.name && mem.type) {
          const ro = hasMod(mem, ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : '';
          const opt = mem.questionToken ? '?' : '';
          members.push({
            text: `${ro}${mem.name.getText(sf)}${opt}: ${_compact(mem.type.getText(sf)).slice(0, IFACE_TYPE_CHARS)}`,
            s: startLine(mem), e: endLine(mem),
          });
        } else if (ts.isMethodSignature(mem) && mem.name) {
          members.push({ text: `${mem.name.getText(sf)}(${paramsText(mem)})`, s: startLine(mem), e: endLine(mem) });
        }
      }
      for (const mem of capMembersWithNotice(members, MEMBER_LIMIT, 'members')) {
        block.push({ text: `  ${mem.text}`, s: mem.s || 0, e: mem.e || 0, marker: !mem.s });
      }
      interfaces.push(...block);
    } else if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
      types.push({ text: `export type ${node.name.text}`, s: startLine(node), e: endLine(node) });
    } else if (ts.isEnumDeclaration(node) && isExported(node)) {
      enums.push({ text: `export enum ${node.name.text}`, s: startLine(node), e: endLine(node) });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const prefix = isExported(node) ? 'export ' : '';
      const abs = hasMod(node, ts.SyntaxKind.AbstractKeyword) ? 'abstract ' : '';
      const block = [{ text: `${prefix}${abs}class ${node.name.text}`, s: startLine(node), e: endLine(node) }];
      const members = [];
      for (const mem of node.members) {
        if (ts.isConstructorDeclaration(mem) && mem.body) {
          members.push({ text: `constructor(${paramsText(mem)})`, s: startLine(mem), e: endLine(mem) });
        } else if (ts.isMethodDeclaration(mem) && mem.body && mem.name) {
          const name = mem.name.getText(sf);
          if (/^(private|protected|_)/.test(name)) continue;
          if (hasMod(mem, ts.SyntaxKind.PrivateKeyword) || hasMod(mem, ts.SyntaxKind.ProtectedKeyword)) continue;
          const st = hasMod(mem, ts.SyntaxKind.StaticKeyword) ? 'static ' : '';
          const as = hasMod(mem, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
          members.push({
            text: `${st}${as}${name}(${paramsText(mem)})${retText(mem, METHOD_RET_CHARS)}`,
            s: startLine(mem), e: endLine(mem),
          });
        }
      }
      for (const mem of capMembersWithNotice(members, MEMBER_LIMIT, 'methods')) {
        block.push({ text: `  ${mem.text}`, s: mem.s || 0, e: mem.e || 0, marker: !mem.s });
      }
      classes.push(...block);
    } else if (ts.isFunctionDeclaration(node) && node.body && node.name && isExported(node)) {
      const as = hasMod(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
      const hint = docHint(node);
      funcs.push({
        text: `export ${as}function ${node.name.text}(${paramsText(node)})${retText(node, FUNC_RET_CHARS)}`,
        s: startLine(node), e: endLine(node), hint,
      });
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        if (!init || !ts.isArrowFunction(init) || !ts.isIdentifier(decl.name)) continue;
        const as = hasMod(init, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
        arrows.push({
          text: `export const ${decl.name.text} = ${as}(${paramsText(init)}) =>`,
          s: startLine(node), e: endLine(node), hint: docHint(node),
        });
      }
    }
  }

  const rows = [...interfaces, ...types, ...enums, ...classes, ...funcs, ...arrows];
  const sigs = rows.map((r) => {
    const base = r.marker ? r.text : `${r.text}${anchor(r.s, r.e)}`;
    return r.hint ? `${base}  # ${r.hint}` : base;
  });
  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

module.exports = { extract, resolveRepoTypescript };
