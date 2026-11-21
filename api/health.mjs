export default function health(_req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      service: 'stocksapp-reports',
      status: 'running',
      paperOnly: true,
    }),
  );
}
