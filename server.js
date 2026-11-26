import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '0.0.0.0';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.normalize(path.join(root, pathname));
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': mime[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } else {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Server error');
    }
  }
});

server.listen(port, host, () => {
  console.log(`BDPT Light Lab running at http://localhost:${port}`);
});
