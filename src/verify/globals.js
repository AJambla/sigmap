'use strict';

/**
 * Language globals the Hallucination Guard must never flag (#777).
 *
 * `fake-symbol` asks "is this name defined in the repo?" — a question that is
 * only meaningful for names the *language* does not already define. The guard
 * previously carried a hand-maintained inline list that stopped at
 * `encodeURIComponent`, so `structuredClone(obj)` — a Node and browser global
 * since Node 17 — was reported as a hallucination at `high` confidence, with a
 * suggested replacement drawn from a test fixture.
 *
 * Kept as grouped data rather than one literal so a missing global is a
 * one-line addition to the right group, and so the groups can be asserted
 * individually in tests.
 *
 * Zero dependencies, deterministic.
 */

/** ECMAScript built-ins available in every JS runtime. */
const ES_GLOBALS = [
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Proxy', 'Reflect',
  'Function', 'Intl', 'globalThis', 'eval', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Generator', 'AsyncGenerator',
];

/** Web/Node platform globals — available in browsers, Node, or both. */
const WEB_GLOBALS = [
  'console', 'fetch', 'Request', 'Response', 'Headers', 'FormData',
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'TextEncoder', 'TextDecoder', 'Blob', 'File', 'FileReader',
  'ReadableStream', 'WritableStream', 'TransformStream',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'atob', 'btoa',
  'crypto', 'performance', 'structuredClone', 'EventTarget', 'Event',
  'CustomEvent', 'MessageChannel', 'MessagePort', 'BroadcastChannel',
  'WebSocket', 'Worker', 'navigator', 'location', 'document', 'window',
  'localStorage', 'sessionStorage', 'alert', 'requestAnimationFrame',
  'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver',
  'MutationObserver', 'DOMParser', 'XMLHttpRequest',
];

/** Node module-scope identifiers and globals. */
const NODE_GLOBALS = [
  'require', 'module', 'exports', '__dirname', '__filename',
  'process', 'Buffer', 'global',
];

/** Test-runner globals — present via the runner, never defined in the repo. */
const TEST_GLOBALS = [
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'before', 'after', 'jest', 'vi', 'suite',
];

/** Python built-ins. */
const PY_GLOBALS = [
  'print', 'len', 'range', 'str', 'int', 'float', 'dict', 'list', 'tuple',
  'set', 'frozenset', 'bool', 'bytes', 'bytearray', 'open', 'enumerate',
  'zip', 'map', 'filter', 'sorted', 'reversed', 'sum', 'min', 'max', 'abs',
  'round', 'pow', 'divmod', 'isinstance', 'issubclass', 'super', 'type',
  'getattr', 'setattr', 'hasattr', 'delattr', 'repr', 'hash', 'id', 'iter',
  'next', 'any', 'all', 'callable', 'format', 'vars', 'dir', 'input',
  'staticmethod', 'classmethod', 'property', 'slice', 'complex', 'ord', 'chr',
];

const GROUPS = {
  es: ES_GLOBALS,
  web: WEB_GLOBALS,
  node: NODE_GLOBALS,
  test: TEST_GLOBALS,
  python: PY_GLOBALS,
};

/** Every global, flattened — the set the guard checks against. */
const LANG_GLOBALS = new Set(
  Object.values(GROUPS).reduce((acc, g) => acc.concat(g), [])
);

module.exports = { LANG_GLOBALS, GROUPS, ES_GLOBALS, WEB_GLOBALS, NODE_GLOBALS, TEST_GLOBALS, PY_GLOBALS };
