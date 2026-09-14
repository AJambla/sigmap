'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { documentSymbols } = require('../lsp/client');
const { anchor } = require('./line-anchor');
const { capWithNotice, capMembersWithNotice } = require('../util/truncate');

// LSP documentSymbol → signature lines (#612, tier T3 of #542). One client,
// every LSP language: symbols come back language-neutral (SymbolKind + name
// + a server-rendered `detail` type string + exact ranges), so the mapping
// below is server-agnostic. Only clangd is measured; the gopls and
// rust-analyzer rows ship designed-but-unmeasured, and any server that is
// absent, crashes, or answers nothing falls back to the regex tier silently.
//
// A session costs a process spawn (~300ms with clangd), so results are
// cached across runs in .context/lsp-cache.json keyed by content hash +
// server command + the server binary's size/mtime — cheap to compute with
// no extra spawn, and invalidated by either a file edit or a server upgrade.

const MEMBER_LIMIT = 120;
const PER_FILE_LIMIT = 200;

// Built-in extension → server command. `exactness.lspServers` in config lays
// entries over this (command arrays, spawned directly — never a shell).
const DEFAULT_SERVERS = {
  '.c': ['clangd'], '.cc': ['clangd'], '.cpp': ['clangd'], '.cxx': ['clangd'],
  '.h': ['clangd'], '.hpp': ['clangd'], '.hh': ['clangd'],
  '.go': ['gopls'],
  '.rs': ['rust-analyzer'],
};

const LANGUAGE_IDS = {
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp',
  '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.go': 'go', '.rs': 'rust',
};

// LSP SymbolKind — containers get their own top-level line; leaf kinds
// inside a container render as indented members.
const KIND_WORDS = {
  2: 'module', 3: 'namespace', 5: 'class', 10: 'enum', 11: 'interface', 23: 'struct',
};
const CONTAINER_KINDS = new Set(Object.keys(KIND_WORDS).map(Number));
const LEAF_KINDS = new Set([6, 7, 8, 9, 12, 13, 14]); // method, property, field, ctor, function, variable, constant

// Per-run state: failed server commands are not retried (a repo with the
// flag on but no server pays one fast ENOENT, not one per file), and the
// cache file is loaded once and written through on miss.
const _deadServers = new Set();
const _serverStat = new Map(); // cmd key → binary stat fragment | null
let _cache = null;
let _cachePath = null;
const _labels = new Set();

function _resolveBinaryStat(cmd0) {
  if (_serverStat.has(cmd0)) return _serverStat.get(cmd0);
  let out = null;
  const candidates = path.isAbsolute(cmd0)
    ? [cmd0]
    : String(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, cmd0));
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) { out = `${st.size}:${Math.round(st.mtimeMs)}`; break; }
    } catch (_) {}
  }
  _serverStat.set(cmd0, out);
  return out;
}

function _loadCache(cwd) {
  if (_cache && _cachePath === path.join(cwd, '.context', 'lsp-cache.json')) return _cache;
  _cachePath = path.join(cwd, '.context', 'lsp-cache.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(_cachePath, 'utf8'));
    _cache = (parsed && parsed.schema === 1) ? parsed : { schema: 1, servers: {}, entries: {} };
  } catch (_) {
    _cache = { schema: 1, servers: {}, entries: {} };
  }
  return _cache;
}

function _saveCache() {
  if (!_cache || !_cachePath) return;
  try {
    fs.mkdirSync(path.dirname(_cachePath), { recursive: true });
    const tmp = _cachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_cache));
    fs.renameSync(tmp, _cachePath);
  } catch (_) {}
}

function _compact(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Flatten hierarchical symbols into the two-level signature vocabulary. */
function _render(symbols) {
  const sigs = [];
  const walk = (nodes) => {
    for (const s of nodes || []) {
      const startLn = s.range.start.line + 1;
      const endLn = s.range.end.line + 1;
      if (CONTAINER_KINDS.has(s.kind)) {
        sigs.push(`${KIND_WORDS[s.kind]} ${s.name}${anchor(startLn, endLn)}`);
        const members = [];
        const nested = [];
        for (const c of s.children || []) {
          if (CONTAINER_KINDS.has(c.kind)) { nested.push(c); continue; }
          if (!LEAF_KINDS.has(c.kind)) continue;
          const detail = _compact(c.detail);
          members.push({
            text: `${c.name}${detail ? ': ' + detail : ''}`,
            s: c.range.start.line + 1,
            e: c.range.end.line + 1,
          });
        }
        for (const mem of capMembersWithNotice(members, MEMBER_LIMIT)) {
          sigs.push(mem.s ? `  ${mem.text}${anchor(mem.s, mem.e)}` : `  ${mem.text}`);
        }
        walk(nested);
      } else if (LEAF_KINDS.has(s.kind)) {
        const detail = _compact(s.detail);
        sigs.push(`${s.name}${detail ? ': ' + detail : ''}${anchor(startLn, endLn)}`);
      }
    }
  };
  walk(symbols);
  return sigs;
}

/**
 * Extract signatures for a file via its registered language server.
 * Returns null on any failure so the caller falls back to the regex tier.
 * @param {string} filePath - absolute path
 * @param {string} src - file content
 * @param {object} [serverOverrides] - `exactness.lspServers` (ext → cmd array)
 * @param {string} [cwd] - project root; enables the cross-run cache
 * @returns {{ sigs: string[], label: string|null }|null}
 */
function extractViaLsp(filePath, src, serverOverrides, cwd) {
  if (!src || typeof src !== 'string') return null;
  const ext = path.extname(filePath).toLowerCase();
  const cmd = (serverOverrides && serverOverrides[ext]) || DEFAULT_SERVERS[ext];
  if (!Array.isArray(cmd) || cmd.length === 0) return null;
  const cmdKey = cmd.join(' ');
  if (_deadServers.has(cmdKey)) return null;

  const binStat = _resolveBinaryStat(cmd[0]);
  const cache = cwd ? _loadCache(cwd) : null;
  const key = binStat
    ? `${crypto.createHash('sha1').update(src).digest('hex')}|${cmdKey}|${binStat}`
    : null;
  if (cache && key && Array.isArray(cache.entries[key])) {
    return { sigs: cache.entries[key], label: cache.servers[cmdKey] || null };
  }

  const languageId = LANGUAGE_IDS[ext] || 'plaintext';
  const out = documentSymbols(cmd, filePath, src, languageId);
  if (!out || out.missing || !out.symbols) {
    if (out && out.missing) _deadServers.add(cmdKey);
    return null;
  }

  const sigs = capWithNotice(_render(out.symbols), PER_FILE_LIMIT, 'signatures');
  if (sigs.length === 0) return null;

  const label = `${out.serverName || path.basename(cmd[0])}@${out.serverVersion || 'unknown'}`;
  if (cache && key) {
    cache.entries[key] = sigs;
    cache.servers[cmdKey] = label;
    _saveCache();
  }
  return { sigs, label };
}

/** Register a label once the caller has ACCEPTED the LSP result — a result
 * rejected by the quality guard must not put its server in the header. */
function acceptLabel(label) {
  if (label) _labels.add(label);
}

/** Toolchain labels for servers whose results were actually used this run. */
function toolchainLabels() {
  return [..._labels].sort();
}

module.exports = { extractViaLsp, acceptLabel, toolchainLabels, DEFAULT_SERVERS };
