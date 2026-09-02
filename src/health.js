import { createServer } from 'node:http';

export function startHealthServer(getStatus) {
  const port = Math.max(1, Number(process.env.PORT || 8080));

  const server = createServer((request, response) => {
    if (request.url !== '/' && request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    const status = getStatus();
    response.writeHead(status.discordReady ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(JSON.stringify(status));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Health server listening on port ${port}`);
  });

  return server;
}

