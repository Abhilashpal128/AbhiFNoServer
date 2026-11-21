import { createHash } from 'node:crypto';
import { z } from 'zod';
const n = z.number().finite(),
  price = n.positive().max(10000000),
  timestamp = n.int().positive();
const date = z.iso.date();
const selection = z
  .object({
    company: z.string().startsWith('NSE_EQ|').max(150),
    symbol: z.string().max(150),
    contract: z.string().max(200).nullable(),
    instrumentKey: z.string().startsWith('NSE_FO|').max(150).nullable(),
    strike: price.nullable(),
    expiry: date.nullable(),
    lotSize: n.int().positive().max(100000).nullable(),
    direction: z.enum(['BULLISH', 'BEARISH']),
    entry: price,
    stop: price,
    target1: price,
    target2: price,
    support: price,
    resistance: price,
    rvol: n.nonnegative(),
    score: n.min(0).max(100),
    analyzedAt: timestamp,
    decision: z.string().max(1000),
    blockers: z.array(z.string().max(1000)).max(30),
  })
  .strict();
const trade = z
  .object({
    id: z.string().max(200),
    company: z.string().startsWith('NSE_EQ|').max(150),
    instrumentKey: z.string().startsWith('NSE_FO|').max(150),
    symbol: z.string().max(200),
    strike: price,
    expiry: date,
    quantity: n.int().positive().max(100000),
    entryPrice: price,
    enteredAt: timestamp,
    entryFee: n.nonnegative(),
    debit: price,
    entrySourceAt: timestamp,
    exitPrice: n.nonnegative().nullable(),
    exitedAt: timestamp.nullable(),
    exitFee: n.nonnegative().nullable(),
    credit: n.nullable(),
    exitSourceAt: timestamp.nullable(),
    markValue: n,
    markAt: timestamp,
    monitoringGap: z.boolean(),
    stop: price,
    target1: price,
    target2: price,
    exitCause: z
      .enum([
        'PREMIUM_STOP',
        'STOCK_STOP',
        'REVERSAL',
        'TARGET_2',
        'TIME_EXIT',
        'RISK_BUDGET',
      ])
      .nullable(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const bad = message => ctx.addIssue({ code: 'custom', message });
    if (Math.abs(t.debit - (t.entryPrice * t.quantity + t.entryFee)) > 0.011)
      bad('Entry ledger does not balance');
    if (t.entrySourceAt > t.enteredAt || t.enteredAt - t.entrySourceAt > 15000)
      bad('Entry observation is stale');
    if (t.exitedAt === null) {
      if (
        [t.exitPrice, t.exitFee, t.credit, t.exitSourceAt].some(v => v !== null)
      )
        bad('Open trade contains a partial exit');
    } else {
      if (
        [t.exitPrice, t.exitFee, t.credit, t.exitSourceAt].some(v => v === null)
      )
        bad('Closed trade is missing a fill');
      if (
        t.exitedAt < t.enteredAt ||
        t.exitSourceAt > t.exitedAt ||
        t.exitedAt - t.exitSourceAt > 15000
      )
        bad('Invalid exit observation');
      if (Math.abs(t.credit - (t.exitPrice * t.quantity - t.exitFee)) > 0.011)
        bad('Exit ledger does not balance');
    }
  });
export const reportSchema = z
  .object({
    version: z.literal(1),
    revision: n.int().nonnegative(),
    week: date,
    startedAt: timestamp,
    observedAt: timestamp,
    openingEquity: n,
    endingEquity: n,
    addedCoins: n.int().min(0).max(1000000),
    targetPercent: z.literal(30),
    selectedAt: timestamp.nullable(),
    selections: z.array(selection).max(5),
    trades: z.array(trade).max(5),
  })
  .strict()
  .superRefine((r, ctx) => {
    const bad = message => ctx.addIssue({ code: 'custom', message });
    if (new Date(`${r.week}T00:00:00Z`).getUTCDay() !== 1)
      bad('Week must start on Monday IST');
    if (r.observedAt < r.startedAt || r.observedAt > Date.now() + 60000)
      bad('Invalid report observation time');
    if (
      new Set(r.selections.map(p => p.company)).size !== r.selections.length ||
      new Set(r.trades.map(t => t.company)).size !== r.trades.length
    )
      bad('Duplicate company');
    for (const t of r.trades) {
      const p = r.selections.find(s => s.company === t.company);
      if (
        !p ||
        p.instrumentKey !== t.instrumentKey ||
        p.strike !== t.strike ||
        p.expiry !== t.expiry ||
        t.quantity !== p.lotSize
      )
        bad('Fill does not match the frozen contract');
    }
  });
const round = n => Math.round(n * 100) / 100;
export function summarize(r) {
  const closed = r.trades.filter(t => t.exitedAt !== null);
  const wins = closed.filter(t => t.credit > t.debit).length;
  const pnl = round(r.endingEquity - r.openingEquity - r.addedCoins);
  const denominator = r.openingEquity + r.addedCoins;
  return {
    pnl,
    percent: denominator > 0 ? (pnl / denominator) * 100 : 0,
    wins,
    closed: closed.length,
    open: r.trades.length - closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    realized: round(closed.reduce((v, t) => v + t.credit - t.debit, 0)),
    fees: round(
      r.trades.reduce((v, t) => v + t.entryFee + (t.exitFee ?? 0), 0),
    ),
    gaps: r.trades.filter(t => t.monitoringGap).length,
    source: 'DEVICE_PAPER_SIMULATION',
    returnMethod: 'GAIN_DIVIDED_BY_OPENING_EQUITY_PLUS_DEPOSITS',
  };
}
export const digest = r =>
  createHash('sha256').update(JSON.stringify(r)).digest('hex');
export function validateTransition(previous, next) {
  if (!previous) return;
  if (
    next.startedAt !== previous.startedAt ||
    next.openingEquity !== previous.openingEquity ||
    next.addedCoins < previous.addedCoins
  )
    throw Object.assign(
      new Error('Opening balance and deposits are immutable'),
      { status: 409 },
    );
  if (next.revision < previous.revision)
    throw Object.assign(new Error('Revision conflict'), { status: 409 });
  if (next.revision === previous.revision && digest(next) !== digest(previous))
    throw Object.assign(new Error('Revision conflict'), { status: 409 });
  if (next.selectedAt !== previous.selectedAt && previous.selectedAt !== null)
    throw Object.assign(new Error('Selection is immutable'), { status: 409 });
  const identities = r =>
    r.selections.map(p => [
      p.company,
      p.instrumentKey,
      p.strike,
      p.expiry,
      p.lotSize,
      p.direction,
      p.entry,
      p.stop,
      p.target1,
      p.target2,
    ]);
  if (
    previous.selectedAt !== null &&
    JSON.stringify(identities(previous)) !== JSON.stringify(identities(next))
  )
    throw Object.assign(new Error('Weekly contracts are immutable'), {
      status: 409,
    });
  for (const t of previous.trades) {
    const nextTrade = next.trades.find(x => x.id === t.id);
    if (
      !nextTrade ||
      [
        'instrumentKey',
        'entryPrice',
        'enteredAt',
        'entryFee',
        'debit',
        'quantity',
      ].some(k => nextTrade[k] !== t[k]) ||
      (t.exitedAt !== null && JSON.stringify(nextTrade) !== JSON.stringify(t))
    )
      throw Object.assign(new Error('Completed fills are immutable'), {
        status: 409,
      });
  }
}
