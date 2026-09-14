'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// Zero-dep synchronous LSP client (#612, tier T3 of #542). SigMap already
// speaks JSON-RPC-over-stdio as an MCP *server*; this is the same wire
// discipline run as a *client*, against a language server the machine
// already has (clangd ships with Xcode CLT; gopls/rust-analyzer where
// installed). Nothing is bundled and nothing is required to exist.
//
// The session is PIPELINED: every frame — initialize, initialized, didOpen,
// documentSymbol, shutdown, exit — is written up front as one stdin buffer
// via spawnSync (args array, never a shell), and the responses are parsed
// from the captured stdout. Measured against clangd: a full round-trip in
// ~290ms with exact multiline ranges. Servers process framed messages in a
// read loop, so pipelining holds; any server that objects simply produces
// no matching response and the caller falls back to the regex tier.

const SESSION_TIMEOUT_MS = 10000;
const MAX_BUFFER = 64 * 1024 * 1024;

function frame(obj) {
  const s = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`;
}

/** Parse Content-Length-framed JSON-RPC messages from a captured stream. */
function parseFrames(raw) {
  const msgs = [];
  let buf = raw || '';
  for (;;) {
    const m = buf.match(/^Content-Length: (\d+)\r\n(?:[^\r\n]+\r\n)*\r\n/);
    if (!m) break;
    const len = parseInt(m[1], 10);
    const body = buf.slice(m[0].length, m[0].length + len);
    if (Buffer.byteLength(body) < len) break;
    try { msgs.push(JSON.parse(body)); } catch (_) {}
    buf = buf.slice(m[0].length + len);
  }
  return msgs;
}

/**
 * One-shot documentSymbol session against a language server.
 * @param {string[]} cmd - command + args (spawned directly, never a shell)
 * @param {string} filePath - absolute path of the file
 * @param {string} src - file content (sent via didOpen; the file need not be saved)
 * @param {string} languageId - LSP language id ('cpp', 'go', 'rust', ...)
 * @returns {{ symbols: object[], serverVersion: string }|null} null on ANY failure
 */
function documentSymbols(cmd, filePath, src, languageId) {
  if (!Array.isArray(cmd) || cmd.length === 0) return null;
  const abs = path.resolve(filePath);
  const uri = 'file://' + abs;
  const input =
    frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      processId: null,
      rootUri: 'file://' + path.dirname(abs),
      capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    } }) +
    frame({ jsonrpc: '2.0', method: 'initialized', params: {} }) +
    frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId, version: 1, text: src },
    } }) +
    frame({ jsonrpc: '2.0', id: 2, method: 'textDocument/documentSymbol', params: { textDocument: { uri } } }) +
    frame({ jsonrpc: '2.0', id: 3, method: 'shutdown' }) +
    frame({ jsonrpc: '2.0', method: 'exit' });

  let r;
  try {
    r = spawnSync(cmd[0], cmd.slice(1), {
      input,
      encoding: 'utf8',
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (_) {
    return { missing: true };
  }
  // A missing binary is permanent for the run; anything else — crash,
  // timeout, empty output — is a per-file failure and must not poison the
  // server for later files (a transient null once cost 12 of 19 files).
  if (r && r.error && r.error.code === 'ENOENT') return { missing: true };
  if (!r || r.error || !r.stdout) return null;

  const msgs = parseFrames(r.stdout);
  const init = msgs.find((x) => x.id === 1 && x.result);
  const sym = msgs.find((x) => x.id === 2);
  if (!sym || !Array.isArray(sym.result)) return null;
  const info = (init && init.result && init.result.serverInfo) || {};
  // Server version strings vary ('Apple clangd version 17.0.0 ...',
  // 'gopls v0.16.1') — pull the first dotted number rather than a word.
  const vm = typeof info.version === 'string' ? info.version.match(/\d+\.[\w.\-]+/) : null;
  return {
    symbols: sym.result,
    serverName: typeof info.name === 'string' ? info.name : '',
    serverVersion: vm ? vm[0] : '',
  };
}

module.exports = { documentSymbols, parseFrames, frame, SESSION_TIMEOUT_MS };
