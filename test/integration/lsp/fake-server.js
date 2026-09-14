'use strict';

// Minimal LSP server speaking Content-Length-framed JSON-RPC on stdio, for
// the #612 hermetic tests: real protocol, canned symbols, no host tools.
// When FAKE_LSP_COUNT_FILE is set, every invocation appends one byte — the
// cache test asserts a second run never spawns it.

const fs = require('fs');
if (process.env.FAKE_LSP_COUNT_FILE) {
  try { fs.appendFileSync(process.env.FAKE_LSP_COUNT_FILE, 'x'); } catch (_) {}
}

// FAKE_LSP_SPARSE simulates a macro-blind server: one bare symbol where the
// regex tier sees a whole class — the quality guard must refuse it.
const SPARSE = [{ name: 'mystery', kind: 13, detail: '', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }];

const SYMBOLS = [{
  name: 'Widget', kind: 5, detail: '',
  range: { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } },
  selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
  children: [
    { name: 'spin', kind: 6, detail: 'void (int)', range: { start: { line: 2, character: 2 }, end: { line: 4, character: 3 } }, selectionRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 11 } } },
  ],
}, {
  name: 'makeWidget', kind: 12, detail: 'Widget (const char *)',
  range: { start: { line: 11, character: 0 }, end: { line: 14, character: 1 } },
  selectionRange: { start: { line: 11, character: 7 }, end: { line: 11, character: 17 } },
}];

const send = (obj) => {
  const s = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
};

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const head = buf.toString('utf8').match(/^Content-Length: (\d+)\r\n(?:[^\r\n]+\r\n)*\r\n/);
    if (!head) return;
    const len = parseInt(head[1], 10);
    const headBytes = Buffer.byteLength(head[0]);
    if (buf.length < headBytes + len) return;
    const msg = JSON.parse(buf.slice(headBytes, headBytes + len).toString('utf8'));
    buf = buf.slice(headBytes + len);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {}, serverInfo: { name: 'fake-lsp', version: 'fake-lsp version 1.2.3' } } });
    } else if (msg.method === 'textDocument/documentSymbol') {
      send({ jsonrpc: '2.0', id: msg.id, result: process.env.FAKE_LSP_SPARSE ? SPARSE : SYMBOLS });
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
  }
});
