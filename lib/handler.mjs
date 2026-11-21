import { timingSafeEqual } from 'node:crypto';
import {
  reportSchema,
  summarize,
  digest,
  validateTransition,
} from './report.mjs';
const send = (res, status, value) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
};
const tokenOK = req => {
  const token = process.env.REPORT_API_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) return false;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
async function body(req) {
  if (req.body !== undefined) {
    const raw =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > 256000)
      throw Object.assign(new Error('Payload too large'), { status: 413 });
    return JSON.parse(raw);
  }
  const parts = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 256000)
      throw Object.assign(new Error('Payload too large'), { status: 413 });
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export function reportHandler(getCollection) {
  return async (req, res) => {
    if (!tokenOK(req)) return send(res, 401, { error: 'Unauthorized' });
    const url = new URL(req.url, 'https://localhost');
    const account = url.searchParams.get('account'),
      week = url.searchParams.get('week');
    if (
      !/^[A-Za-z0-9_-]{8,80}$/.test(account || '') ||
      (week && !/^\d{4}-\d{2}-\d{2}$/.test(week))
    )
      return send(res, 400, { error: 'Invalid account or week' });
    if (!['GET', 'PUT'].includes(req.method)) {
      res.setHeader('Allow', 'GET, PUT');
      return send(res, 405, { error: 'Method not allowed' });
    }
    try {
      let payload;
      if (req.method === 'PUT') {
        if (
          !req.headers['content-type']?.startsWith('application/json') ||
          !week
        )
          return send(res, 400, {
            error: 'A JSON report and week are required',
          });
        const parsed = reportSchema.safeParse(await body(req));
        if (!parsed.success || parsed.data.week !== week)
          return send(res, 400, { error: 'Report validation failed' });
        payload = parsed.data;
      }
      const db = await getCollection(),
        id = `${account}:${week}`;
      if (req.method === 'GET') {
        if (week) {
          const found = await db.findOne(
            { _id: id },
            { projection: { _id: 0, hash: 0 } },
          );
          return send(
            res,
            found ? 200 : 404,
            found ?? { error: 'Report not found' },
          );
        }
        // Paginate by week; all historical reports remain in MongoDB.
        const before = url.searchParams.get('before');
        if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before))
          return send(res, 400, { error: 'Invalid cursor' });
        const rows = await db
          .find(
            { account, ...(before ? { week: { $lt: before } } : {}) },
            {
              projection: {
                _id: 0,
                week: 1,
                revision: 1,
                summary: 1,
                savedAt: 1,
              },
            },
          )
          .sort({ week: -1 })
          .limit(52)
          .toArray();
        return send(res, 200, {
          reports: rows,
          nextBefore: rows.length === 52 ? rows.at(-1).week : null,
        });
      }
      const previous = await db.findOne({ _id: id });
      validateTransition(previous?.report, payload);
      const hash = digest(payload);
      if (previous?.revision === payload.revision && previous.hash === hash)
        return send(res, 200, {
          week,
          revision: payload.revision,
          summary: previous.summary,
        });
      const document = {
        _id: id,
        account,
        week,
        revision: payload.revision,
        hash,
        report: payload,
        summary: summarize(payload),
        savedAt: new Date().toISOString(),
      };
      if (!previous) await db.insertOne(document);
      else {
        const result = await db.replaceOne(
          { _id: id, revision: previous.revision, hash: previous.hash },
          document,
        );
        if (result.matchedCount !== 1)
          return send(res, 409, { error: 'Concurrent report update; retry' });
      }
      return send(res, 200, {
        week,
        revision: payload.revision,
        summary: document.summary,
      });
    } catch (e) {
      if (e?.code === 11000 || e?.status === 409)
        return send(res, 409, {
          error: 'Revision or immutable-history conflict',
        });
      if (e?.status === 413)
        return send(res, 413, { error: 'Payload too large' });
      if (e instanceof SyntaxError)
        return send(res, 400, { error: 'Invalid JSON' });
      // Provider credentials, connection strings and database errors never reach clients/logs.
      return send(res, 503, {
        error: 'Report storage unavailable; retry later',
      });
    }
  };
}
