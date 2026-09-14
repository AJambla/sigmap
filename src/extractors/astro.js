'use strict';

const { capWithNotice } = require('../util/truncate');
const typescript = require('./typescript');

// Ceiling discloses what it drops rather than truncating silently (#576).
const PER_FILE_LIMIT = 200;
const MAX_COMPONENT_HINTS = 8;

/**
 * Extract signatures from Astro components (.astro) — frontmatter + template
 * (#539). The TS frontmatter between `---` fences is delegated to the real
 * TypeScript extractor (anchors shifted to file coordinates), so functions,
 * consts, and the Props interface come out with full fidelity; capitalized
 * component usages in the template are appended as a compact hint, mirroring
 * the vue_sfc/svelte family.
 *
 * @param {string} src - Raw file content
 * @returns {string[]} Array of signature strings
 */
function extract(src) {
  if (!src || typeof src !== 'string') return [];
  const sigs = [];

  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (fm) {
    // Frontmatter content starts on line 2 of the file.
    const offset = 1;
    // Astro's Props convention is usually non-exported; the TS extractor only
    // matches `export interface`. Prefixing on the SAME line keeps every line
    // number — and therefore every anchor — valid.
    const body = fm[1].replace(/^(\s*)interface Props\b/m, '$1export interface Props');
    for (const sig of typescript.extract(body)) {
      sigs.push(sig.replace(/ {2}:(\d+)-(\d+)/, (_, s, e) => `  :${Number(s) + offset}-${Number(e) + offset}`));
    }

    // Frontmatter code is file-local by design, so the exported-only passes
    // above miss most of it. Astro-specific surface:
    const lineOf = (idx) => body.slice(0, idx).split('\n').length + offset;

    // const { title, description = 'x' } = Astro.props — the props actually consumed.
    const propsUse = /^const\s*\{([^}]+)\}\s*=\s*Astro\.props/m.exec(body);
    if (propsUse) {
      const names = propsUse[1].split(',').map((p) => p.trim().split(/[=:]/)[0].trim()).filter(Boolean);
      const ln = lineOf(propsUse.index);
      sigs.push(`props { ${names.join(', ')} }  :${ln}-${ln}`);
    }

    // Non-exported top-level functions (the norm in frontmatter).
    for (const m of body.matchAll(/^(async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{=\n]+))?/gm)) {
      if (m[2].startsWith('_')) continue;
      const params = m[3].trim().replace(/\s+/g, ' ').split(',').map((p) => p.split(':')[0].trim()).filter(Boolean).join(', ');
      const ret = m[4] ? ` → ${m[4].trim().replace(/\s+/g, ' ').slice(0, 25)}` : '';
      const ln = lineOf(m.index);
      sigs.push(`${m[1] ? 'async ' : ''}function ${m[2]}(${params})${ret}  :${ln}-${ln}`);
    }

    // Data-loading consts: const posts = await getCollection('blog').
    for (const m of body.matchAll(/^const\s+(\w+)\s*=\s*await\s+(\w[\w.]*)\s*\(/gm)) {
      const ln = lineOf(m.index);
      sigs.push(`const ${m[1]} = await ${m[2]}()  :${ln}-${ln}`);
    }
  }

  // Component usages in the template: <Layout ...>, <Card />, dotted islands.
  const template = fm ? src.slice(fm.index + fm[0].length) : src;
  const used = new Set();
  for (const m of template.matchAll(/<([A-Z][\w.]*)[\s/>]/g)) {
    used.add(m[1]);
  }
  if (used.size > 0) {
    const names = [...used].sort();
    const shown = names.slice(0, MAX_COMPONENT_HINTS);
    const more = names.length - shown.length;
    sigs.push(`uses ${shown.join(', ')}${more > 0 ? ` … +${more} more` : ''}`);
  }

  return capWithNotice(sigs, PER_FILE_LIMIT, 'signatures');
}

module.exports = { extract };
