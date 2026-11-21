import { createServer } from 'node:http';
import reports from './api/reports.mjs';
import health from './api/health.mjs';
createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/reports') return reports(req, res);
  if (path === '/api/health') return health(req, res);
  res.statusCode = 404;
  res.end('Not found');
}).listen(Number(process.env.PORT || 3000), '127.0.0.1', () =>
  console.log('Report backend listening on localhost'),
);
