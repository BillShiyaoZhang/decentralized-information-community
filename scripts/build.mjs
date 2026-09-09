import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCommunity, projectRoot } from './community-config.mjs';
export async function buildSite({ root = projectRoot, env = process.env, output = resolve(root, 'dist') } = {}) {
  const { graph, site } = await loadCommunity({ root, env });
  const out = resolve(output);
  await mkdir(`${out}/data`, { recursive: true });
  await cp(`${projectRoot}/web`, out, { recursive: true });
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const html = (await readFile(`${out}/index.html`, 'utf8'))
    .replace(/<title>.*?<\/title>/, `<title>${escape(graph.title)} · ${escape(site.brand)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escape(graph.description ?? site.tagline)}">`);
  await writeFile(`${out}/index.html`, html);
  for (const name of ['core', 'adapters']) {
    await mkdir(`${out}/packages/${name}`, { recursive: true });
    await cp(`${projectRoot}/packages/${name}/index.js`, `${out}/packages/${name}/index.js`);
  }
  await writeFile(`${out}/data/graph.json`, JSON.stringify(graph, null, 2) + '\n');
  await writeFile(`${out}/runtime-config.json`, JSON.stringify({ mode: 'static', graphUrl: './data/graph.json', apiUrl: './api', site }));
  await writeFile(`${out}/.nojekyll`, '');
  console.log(`Built static site: ${graph.nodes.length} nodes, ${graph.edges.length} edges; relative URLs support GitHub Pages subpaths.`);
  return { graph, site, output: out };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSite();
