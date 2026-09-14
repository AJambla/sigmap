'use strict';

// Zero-dep SCIP index reader (#618, tier T4 of #542). SCIP is Sourcegraph's
// protobuf index format; indexers exist for TS/Java/Python/Rust/C++/Ruby and
// more, and a repo whose CI already produces `index.scip` has compiler-grade
// signatures sitting on disk. This reads them — import only, nothing emitted.
//
// The wire subset needed is tiny: varints and length-delimited fields. Field
// numbers are grounded from the scip bindings vendored by scip-typescript
// (src/scip.ts getter → field-number pairs), and the reader is validated
// against a real index produced by that tool:
//   Index            metadata=1 · documents=2
//   Metadata         tool_info=2 (ToolInfo: name=1 version=2)
//   Document         relative_path=1 · occurrences=2 · symbols=3
//   SymbolInformation symbol=1 · documentation=3
//   Occurrence       range=1 (packed) · symbol=2 · symbol_roles=3 · enclosing_range=7
// Anything unrecognized is skipped by wire type, so newer fields are inert.

function readVarint(buf, pos) {
  let v = 0n, shift = 0n, p = pos;
  for (;;) {
    const b = buf[p++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [Number(v), p];
}

/** Iterate [fieldNumber, value] pairs of one protobuf message. */
function* fields(buf) {
  let p = 0;
  while (p < buf.length) {
    let key;
    [key, p] = readVarint(buf, p);
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) { let v; [v, p] = readVarint(buf, p); yield [field, v]; }
    else if (wire === 2) { let len; [len, p] = readVarint(buf, p); yield [field, buf.slice(p, p + len)]; p += len; }
    else if (wire === 5) { p += 4; }
    else if (wire === 1) { p += 8; }
    else throw new Error(`scip: unknown wire type ${wire}`);
  }
}

function packedVarints(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) { let v; [v, p] = readVarint(buf, p); out.push(v); }
  return out;
}

const DEFINITION_ROLE = 0x1;

/**
 * Parse a SCIP index buffer into a compact per-document structure.
 * Throws on malformed input — callers treat any throw as "no index".
 * @param {Buffer} buf
 * @returns {{ tool: string, documents: Map<string, { symbols: Map<string, string[]>, defs: Array<{symbol: string, range: number[]}> }> }}
 */
function parseIndex(buf) {
  let tool = '';
  const documents = new Map();
  for (const [f, v] of fields(buf)) {
    if (f === 1) {
      for (const [mf, mv] of fields(v)) {
        if (mf === 2) {
          let name = '', version = '';
          for (const [tf, tv] of fields(mv)) {
            if (tf === 1) name = tv.toString('utf8');
            if (tf === 2) version = tv.toString('utf8');
          }
          tool = version ? `${name}@${version}` : name;
        }
      }
    } else if (f === 2) {
      let relPath = '';
      const symbols = new Map();
      const defs = [];
      for (const [df, dv] of fields(v)) {
        if (df === 1) relPath = dv.toString('utf8');
        else if (df === 3) {
          let symbol = '';
          const docs = [];
          for (const [sf, sv] of fields(dv)) {
            if (sf === 1) symbol = sv.toString('utf8');
            if (sf === 3) docs.push(sv.toString('utf8'));
          }
          if (symbol) symbols.set(symbol, docs);
        } else if (df === 2) {
          let range = null, symbol = '', roles = 0, enclosing = null;
          for (const [of, ov] of fields(dv)) {
            if (of === 1) range = Buffer.isBuffer(ov) ? packedVarints(ov) : [ov];
            if (of === 2) symbol = ov.toString('utf8');
            if (of === 3) roles = ov;
            if (of === 7) enclosing = Buffer.isBuffer(ov) ? packedVarints(ov) : [ov];
          }
          if ((roles & DEFINITION_ROLE) && symbol && range) defs.push({ symbol, range, enclosing });
        }
      }
      if (relPath) documents.set(relPath.replace(/\\/g, '/'), { symbols, defs });
    }
  }
  return { tool, documents };
}

module.exports = { parseIndex, fields, readVarint, packedVarints, DEFINITION_ROLE };
