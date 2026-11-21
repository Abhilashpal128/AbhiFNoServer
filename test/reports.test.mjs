import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { reportHandler } from '../lib/handler.mjs';
import { reportSchema, summarize, validateTransition } from '../lib/report.mjs';
const at = Date.parse('2026-11-16T04:30:00Z');
const sample = () => ({
  version: 1,
  revision: 1,
  week: '2026-11-16',
  startedAt: at,
  observedAt: at + 30000,
  openingEquity: 50000,
  endingEquity: 55000,
  addedCoins: 5000,
  targetPercent: 30,
  selectedAt: null,
  selections: [],
  trades: [],
});

test('deposits are not returns and empty weeks have no invented win rate', () => {
  const summary = summarize(reportSchema.parse(sample()));
  assert.equal(summary.pnl, 0);
  assert.equal(summary.percent, 0);
  assert.equal(summary.winRate, null);
  assert.equal(summarize({ ...sample(), endingEquity: 55550 }).percent, 1);
});
test('filled-trade accounting and frozen weekly identities remain consistent', () => {
  const selection = {
    company: 'NSE_EQ|TEST',
    symbol: 'TEST',
    contract: 'TEST 100 CE 29 DEC 26',
    instrumentKey: 'NSE_FO|123',
    strike: 100,
    expiry: '2026-12-29',
    lotSize: 100,
    direction: 'BULLISH',
    entry: 100,
    stop: 96,
    target1: 108,
    target2: 112,
    support: 96,
    resistance: 108,
    rvol: 2,
    score: 75,
    analyzedAt: at,
    decision: 'PAPER BUY',
    blockers: [],
  };
  const trade = {
    id: '2026-11-16:NSE_EQ|TEST',
    company: selection.company,
    instrumentKey: selection.instrumentKey,
    symbol: selection.contract,
    strike: 100,
    expiry: selection.expiry,
    quantity: 100,
    entryPrice: 10,
    enteredAt: at,
    entryFee: 25,
    debit: 1025,
    entrySourceAt: at,
    exitPrice: 12,
    exitedAt: at + 30000,
    exitFee: 26,
    credit: 1174,
    exitSourceAt: at + 30000,
    markValue: 1174,
    markAt: at + 30000,
    monitoringGap: true,
    stop: 8,
    target1: 11,
    target2: 12,
    exitCause: 'TARGET_2',
  };
  const report = {
    ...sample(),
    selectedAt: at,
    selections: [selection],
    trades: [trade],
    endingEquity: 55149,
  };
  const parsed = reportSchema.parse(report);
  assert.equal(summarize(parsed).realized, 149);
  assert.equal(summarize(parsed).fees, 51);
  assert.equal(summarize(parsed).gaps, 1);
  assert.equal(
    reportSchema.safeParse({ ...report, trades: [{ ...trade, debit: 1000 }] })
      .success,
    false,
  );
  assert.equal(
    reportSchema.safeParse({ ...report, trades: [{ ...trade, strike: 110 }] })
      .success,
    false,
  );
  assert.throws(
    () =>
      validateTransition(parsed, {
        ...parsed,
        revision: 2,
        selections: [{ ...selection, strike: 110 }],
      }),
    /immutable/,
  );
  assert.throws(
    () =>
      validateTransition(parsed, {
        ...parsed,
        revision: 2,
        trades: [{ ...trade, credit: 2000 }],
      }),
    /immutable/,
  );
  assert.doesNotThrow(() =>
    validateTransition(parsed, {
      ...parsed,
      revision: 2,
      selections: [{ ...selection, support: 97 }],
    }),
  );
});
test('validation rejects secrets, non-Monday buckets, invalid amounts and duplicate history', () => {
  assert.equal(
    reportSchema.safeParse({ ...sample(), upstoxToken: 'must-never-upload' })
      .success,
    false,
  );
  assert.equal(
    reportSchema.safeParse({ ...sample(), week: '2026-11-17' }).success,
    false,
  );
  assert.equal(
    reportSchema.safeParse({ ...sample(), endingEquity: Infinity }).success,
    false,
  );
  assert.throws(
    () => validateTransition(sample(), { ...sample(), revision: 0 }),
    /conflict/,
  );
  assert.throws(
    () => validateTransition(sample(), { ...sample(), endingEquity: 60000 }),
    /conflict/,
  );
});
test('authenticated HTTP writes are idempotent, persist summaries, reject old revisions and survive retry', async () => {
  process.env.REPORT_API_TOKEN = 'a'.repeat(64);
  const docs = new Map();
  let writes = 0;
  const db = {
    async findOne(q) {
      return structuredClone(docs.get(q._id) ?? null);
    },
    async insertOne(d) {
      if (docs.has(d._id))
        throw Object.assign(new Error('duplicate'), { code: 11000 });
      docs.set(d._id, structuredClone(d));
      writes++;
    },
    async replaceOne(q, d) {
      const previous = docs.get(q._id);
      if (
        !previous ||
        previous.revision !== q.revision ||
        previous.hash !== q.hash
      )
        return { matchedCount: 0 };
      docs.set(d._id, structuredClone(d));
      writes++;
      return { matchedCount: 1 };
    },
  };
  const server = createServer(reportHandler(async () => db));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${
    server.address().port
  }/api/reports?account=device_test&week=2026-11-16`;
  const headers = {
    authorization: `Bearer ${process.env.REPORT_API_TOKEN}`,
    'content-type': 'application/json',
  };
  const put = r =>
    fetch(url, { method: 'PUT', headers, body: JSON.stringify(r) });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await put(sample())).status, 200);
    assert.equal((await put(sample())).status, 200);
    assert.equal(writes, 1);
    assert.equal((await put({ ...sample(), revision: 0 })).status, 409);
    assert.equal(
      (await put({ ...sample(), revision: 2, endingEquity: 56100 })).status,
      200,
    );
    const response = await (await fetch(url, { headers })).json();
    assert.equal(response.summary.pnl, 1100);
    assert.equal(response.summary.percent, 2);
    assert.equal(response.report.revision, 2);
    assert.equal(
      (await put({ ...sample(), trades: [{ nonsense: true }] })).status,
      400,
    );
    assert.equal(
      (await fetch(url.replace('device_test', '$ne'), { headers })).status,
      400,
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
test('database failure returns a retryable response without exposing the connection string', async () => {
  process.env.REPORT_API_TOKEN = 'b'.repeat(64);
  const handler = reportHandler(async () => {
    throw new Error('mongodb+srv://secret:password@private');
  });
  let status, output;
  const res = {
    setHeader() {},
    set statusCode(v) {
      status = v;
    },
    end(v) {
      output = v;
    },
  };
  await handler(
    {
      method: 'GET',
      url: '/api/reports?account=device_test&week=2026-11-16',
      headers: { authorization: `Bearer ${process.env.REPORT_API_TOKEN}` },
    },
    res,
  );
  assert.equal(status, 503);
  assert.ok(!output.includes('secret'));
  assert.ok(!output.includes('mongodb'));
});
