// 仅提供静态文件，不含模型调用、数据库或推荐 API。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webm': 'video/webm' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/Demo.html') {
      const content = await readFile(new URL('../Demo.html', import.meta.url));
      response.writeHead(200, { 'Content-Type': types['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(content);
      return;
    }
    const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root.endsWith(sep) ? root : root + sep) || !types[extname(target)]) {
      response.writeHead(404).end('Not found'); return;
    }
    const content = await readFile(target);
    if (extname(target) === '.webm') {
      const headers = { 'Content-Type': types['.webm'], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        let start = range?.[1] ? Number(range[1]) : Math.max(0, content.length - Number(range?.[2]));
        let end = range?.[1] && range[2] ? Math.min(Number(range[2]), content.length - 1) : content.length - 1;
        if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= content.length) {
          response.writeHead(416, { ...headers, 'Content-Range': `bytes */${content.length}` }).end(); return;
        }
        const slice = content.subarray(start, end + 1);
        response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': slice.length });
        response.end(request.method === 'HEAD' ? undefined : slice); return;
      }
      response.writeHead(200, { ...headers, 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content); return;
    }
    response.writeHead(200, { 'Content-Type': types[extname(target)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.on('error', (error) => { console.error(`Demo 启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`漫游 Demo: http://127.0.0.1:${server.address().port}`));
