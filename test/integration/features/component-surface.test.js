'use strict';

/**
 * Web-component surface (#537): the tag name / selector and reactive fields
 * ARE a component's public API, and the class extractors lost them. Every
 * addition is gated on detecting a component marker, so non-component
 * classes must stay byte-identical.
 */

const assert = require('assert');
const tsx = require('../../../src/extractors/typescript');
const jsx = require('../../../src/extractors/javascript');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const LIT = [
  "import { LitElement, html } from 'lit';",
  "import { customElement, property, state } from 'lit/decorators.js';",
  '',
  "@customElement('user-card')",
  'export class UserCard extends LitElement {',
  "  @property() name = '';",
  '  @property({ type: Number }) age?: number;',
  '  @state() _open = false;',
  '',
  '  render() {',
  '    return html`<div></div>`;',
  '  }',
  '}',
].join('\n');

const NG = [
  '@Component({',
  "  selector: 'app-user',",
  "  templateUrl: './user.html',",
  '})',
  'export class UserComponent {',
  '  @Input() userId: string;',
  '  @Output() saved: EventEmitter<string> = new EventEmitter();',
  '',
  '  save(id: string): void {',
  '    this.saved.emit(id);',
  '  }',
  '}',
].join('\n');

const VANILLA = 'class XButton extends HTMLElement {\n  connectedCallback() {\n    this.textContent = "x";\n  }\n}\ncustomElements.define("x-button", XButton);\nmodule.exports = { XButton };\n';

test('Lit: tag, reactive properties with types, and base are visible', () => {
  const sigs = tsx.extract(LIT);
  assert.ok(sigs.some((s) => s.startsWith('export class UserCard extends LitElement')), `base missing: ${sigs[0]}`);
  assert.ok(sigs.some((s) => s.includes('custom element <user-card>')), 'tag missing');
  assert.ok(sigs.some((s) => s.includes('@property age?: number')), 'typed reactive property missing');
  assert.ok(sigs.some((s) => s.includes('@state _open')), 'state field missing');
  assert.ok(sigs.some((s) => s.includes('render()')), 'ordinary methods must still extract');
});

test('Angular: selector and inputs/outputs are visible', () => {
  const sigs = tsx.extract(NG);
  assert.ok(sigs.some((s) => s.includes("selector 'app-user'")), 'selector missing');
  assert.ok(sigs.some((s) => s.includes('@Input() userId: string')), 'input missing');
  assert.ok(sigs.some((s) => s.includes('@Output() saved: EventEmitter<string>')), 'output missing');
});

test('customElements.define attaches the tag to the class (JS)', () => {
  const sigs = jsx.extract(VANILLA);
  assert.ok(sigs.some((s) => s.startsWith('class XButton extends HTMLElement')), `base missing: ${sigs[0]}`);
  assert.ok(sigs.some((s) => s.includes('custom element <x-button>')), 'tag missing');
});

test('non-component classes are byte-identical (no base, no markers)', () => {
  const plainTs = 'export class Plain extends Base {\n  go(a: number): void {\n    return;\n  }\n}\n';
  const sigs = tsx.extract(plainTs);
  assert.ok(sigs.some((s) => s === 'export class Plain  :1-5'), `base leaked onto a non-component class: ${sigs[0]}`);
  assert.ok(!sigs.some((s) => /custom element|selector '/.test(s)));
  const plainJs = 'class Widget extends Thing {\n  spin(n) {\n    return n;\n  }\n}\nmodule.exports = { Widget };\n';
  const jsSigs = jsx.extract(plainJs);
  assert.ok(jsSigs.some((s) => s === 'class Widget  :1-5'), `base leaked in JS: ${jsSigs[0]}`);
});

test('a decorator separated from the class by real code does not attach', () => {
  const src = "@customElement('x-a')\nconst unrelated = 1;\nexport class NotAComponent {\n  go(): void {\n    return;\n  }\n}\n";
  const sigs = tsx.extract(src);
  assert.ok(!sigs.some((s) => s.includes('custom element')), 'marker crossed real code to a later class');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
