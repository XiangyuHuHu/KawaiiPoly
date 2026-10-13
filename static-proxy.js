import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const port = Number(process.env.PORT || 3000);
const upstream = new URL(process.env.API_UPSTREAM_URL || 'http://app:3000');
const publicRoot = resolve(process.cwd(), 'public');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function proxyApi(request, response) {
  const target = new URL(request.url, upstream);
  const proxy = http.request(target, {
    method: request.method,
    headers: {
      ...request.headers,
      host: upstream.host
    }
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  proxy.setTimeout(30_000, () => {
    proxy.destroy(new Error('API upstream timeout'));
  });
  proxy.on('error', (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error.message }));
  });
  request.pipe(proxy);
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/winrate' || pathname === '/winrate/'
    ? '/winrate.html'
    : (pathname === '/' ? '/index.html' : pathname);
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    response.writeHead(400).end('Bad Request');
    return;
  }
  const filePath = resolve(publicRoot, `.${decoded}`);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=60'
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    proxyApi(request, response);
    return;
  }
  serveStatic(url.pathname, response).catch((error) => {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error.message);
  });
});

server.listen(port, () => {
  console.log(`Dashboard proxy running at http://localhost:${port} -> ${upstream.origin}`);
});
