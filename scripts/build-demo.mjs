import { readFile, writeFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');
const [html, css, ...modules] = await Promise.all([
  read('demo/index.html'), read('demo/styles.css'), read('demo/data.mjs'),
  read('demo/recommendation.mjs'), read('demo/art.mjs'), read('demo/app.mjs'),
]);
// 依赖均为项目内模块；合并后单文件可通过 file:// 直接运行。
const script = modules.map((source) => source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')).join('\n\n');
new Script(script, { filename: 'Demo.html:inline-script' });
const output = html.replace('<link rel="stylesheet" href="./styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="./app.mjs"></script>', () => `<script type="module">\n${script.replace(/<\/script/gi, '<\\/script')}\n</script>`);
await writeFile(new URL('Demo.html', root), output, 'utf8');
console.log('已生成 Demo.html：可直接双击打开，所有样式、数据和插画均内嵌。');
