// src/lib/msmed-interest.mjs
//
// MSMED Act, 2006
//  - Section 15: payment due by the agreed date, never later than 45 days
//                from the day of acceptance (or deemed acceptance).
//  - Section 16: interest is compound, with monthly rests, at 3x the
//                RBI Bank Rate.
//
// Rate handling: the Bank Rate in force at the start of each monthly rest is
// used for that whole month. BANK_RATE_HISTORY currently holds one verified
// row. To support older invoices, add earlier rows ONLY after checking them
// on rbi.org.in. When the RBI revises the rate, append a new row.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DUE_DAYS = 45;
const MULTIPLIER = 3;

// Sorted oldest -> newest. Rate is a percentage.
export const BANK_RATE_HISTORY = [
  { from: '2025-12-05', rate: 5.5 }, // RBI Bank Rate (aligned with MSF), verified Aug 2026
];

// ---------- date helpers (all UTC) ----------

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const fmt = (date) => date.toISOString().slice(0, 10);
const addDays = (date, n) => new Date(date.getTime() + n * DAY_MS);
const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / DAY_MS);
const round2 = (x) => Math.round(x * 100) / 100;

function addMonths(date, n) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + n;
  const d = date.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay)));
}

// ---------- bank rate lookup ----------

// Returns { rate, verified }. Dates before the first row fall back to the
// first row's rate and are flagged as unverified.
export function getBankRate(date) {
  const first = BANK_RATE_HISTORY[0];
  if (date < parseDate(first.from)) {
    return { rate: first.rate, verified: false };
  }
  let applicable = first;
  for (const row of BANK_RATE_HISTORY) {
    if (parseDate(row.from) <= date) applicable = row;
  }
  return { rate: applicable.rate, verified: true };
}

// ---------- main calculation ----------

export function calculateInterest({
  invoiceAmount,
  acceptanceDate,
  paymentDate = null,
  asOf = null,
  agreedPaymentDays = null, // from a written agreement; capped at 45
}) {
  if (!invoiceAmount || !acceptanceDate) {
    throw new Error('invoiceAmount and acceptanceDate are required');
  }

  const termDays = agreedPaymentDays
    ? Math.min(agreedPaymentDays, MAX_DUE_DAYS)
    : MAX_DUE_DAYS;
  const due = addDays(parseDate(acceptanceDate), termDays);
  const end = parseDate(paymentDate || asOf || fmt(new Date()));

  const base = {
    principal: invoiceAmount,
    paymentTermDays: termDays,
    dueDate: fmt(due),
    calculatedTill: fmt(end),
    sections: ['Section 15', 'Section 16', 'Section 17', 'Section 18'],
  };

  if (end <= due) {
    return {
      ...base,
      overdueDays: 0,
      interest: 0,
      totalPayable: invoiceAmount,
      breakdown: [],
      warnings: [],
    };
  }

  let principal = invoiceAmount; // grows at each full monthly rest
  let totalInterest = 0;
  let usedUnverifiedRate = false;
  const breakdown = [];

  let periodStart = due;
  let month = 0;

  while (periodStart < end) {
    const nextRest = addMonths(due, month + 1);
    const isFullMonth = nextRest <= end;
    const periodEnd = isFullMonth ? nextRest : end;

    const { rate: bankRate, verified } = getBankRate(periodStart);
    if (!verified) usedUnverifiedRate = true;

    const annualRate = (bankRate * MULTIPLIER) / 100;
    const days = daysBetween(periodStart, periodEnd);
    const interest = (principal * annualRate * days) / 365;

    breakdown.push({
      month: month + 1,
      from: fmt(periodStart),
      to: fmt(periodEnd),
      days,
      bankRatePct: bankRate,
      interestRatePct: round2(annualRate * 100),
      principalAtStart: round2(principal),
      interest: round2(interest),
    });

    totalInterest += interest;
    if (isFullMonth) principal += interest; // monthly rest: capitalise
    month += 1;
    periodStart = periodEnd;
  }

  const warnings = [];
  if (usedUnverifiedRate) {
    warnings.push(
      `Rate history before ${BANK_RATE_HISTORY[0].from} is not verified; the current Bank Rate was used for earlier months.`
    );
  }

  const latest = getBankRate(end);
  return {
    ...base,
    overdueDays: daysBetween(due, end),
    currentBankRatePct: latest.rate,
    currentInterestRatePct: round2(latest.rate * MULTIPLIER),
    interest: round2(totalInterest),
    totalPayable: round2(invoiceAmount + totalInterest),
    breakdown,
    warnings,
    note: 'Estimate only. Verify against the current RBI Bank Rate and MSEFC guidance.',
  };
}