'use strict';

/**
 * The single definition of a graph node key.
 *
 * src/graph/builder.js and src/graph/call-graph.js each used to normalise paths
 * their own way — builder lowercased, call-graph did not — so a lookup written
 * for one silently missed on the other. That divergence disabled the import
 * boost on every repo whose path contains an uppercase letter, and later caused
 * a "fix" for one graph to break the other. Both now key through this function,
 * so there is one convention rather than two conventions and a convention.
 *
 * Lowercasing keeps lookups stable across case-insensitive filesystems (macOS,
 * Windows), where the same file legitimately arrives spelled two ways.
 *
 * Zero-dependency, pure, bundle-safe.
 */

const path = require('path');

/** Canonical key for a filesystem path used as a graph node. */
function graphKey(p) {
  return path.normalize(String(p)).toLowerCase();
}

/**
 * Render a graph node key as a repo-relative path in its ORIGINAL case.
 *
 * Keys are lowercased for identity (see above), but `path.relative(cwd, key)`
 * then finds no common prefix on any checkout whose path contains an uppercase
 * letter (every macOS `/Users/...`) and climbs to the filesystem root. Graphs
 * carry a `realPaths` map (key -> original-case absolute path) so display can
 * recover the real spelling; the case-insensitive prefix strip below is the
 * fallback for keys that predate the map or came from another graph.
 *
 * @param {string} key              graph node key (or any absolute path)
 * @param {string} cwd              project root
 * @param {Map<string,string>} [realPaths]
 * @returns {string} repo-relative, forward-slashed, original case where known
 */
function displayPath(key, cwd, realPaths) {
  const real = (realPaths && realPaths.get(key)) || key;
  const rel = path.relative(cwd, real);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.replace(/\\/g, '/');
  }
  // Fallback: strip the cwd prefix case-insensitively rather than climbing out.
  const norm = path.normalize(real);
  const normCwd = path.normalize(cwd);
  if (norm.toLowerCase().startsWith(normCwd.toLowerCase())) {
    return norm.slice(normCwd.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  }
  return rel.replace(/\\/g, '/');
}

module.exports = { graphKey, displayPath };
