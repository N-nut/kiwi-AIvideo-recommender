import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('静态预览提供页面、模块和独立 Demo，并拒绝访问项目配置', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../demo/server.mjs', import.meta.url))], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      child.on('error', reject);
      child.once('exit', (code) => reject(new Error(`静态服务提前退出：${code}`)));
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      });
    });
    const home = await fetch(url);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const module = await fetch(`${url}/app.mjs`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /text\/javascript/);
    const standalone = await fetch(`${url}/Demo.html`);
    assert.equal(standalone.status, 200);
    const html = await standalone.text();
    assert.match(html, /漫游/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/i);
    assert.equal((await fetch(`${url}/package.json`)).status, 404);
    assert.equal((await fetch(`${url}/%2e%2e%5cpackage.json`)).status, 404);
  } finally {
    child.kill();
    await exited;
  }
});
