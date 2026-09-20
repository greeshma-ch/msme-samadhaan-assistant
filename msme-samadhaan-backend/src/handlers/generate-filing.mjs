// src/handlers/generate-filing.mjs
import { calculateInterest } from '../lib/msmed-interest.mjs';

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};
const reply = (statusCode, payload) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(payload),
});

const inr = (n) =>
  '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = (s) =>
  new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

function templateNarrative(f) {
  const inv = f.invoiceNumber ? `Invoice No. ${f.invoiceNumber}` : 'an invoice';
  const dated = f.invoiceDate ? ` dated ${f.invoiceDate}` : '';
  return (
    `The Claimant, ${f.supplier}, supplied goods/services to the Respondent, ${f.buyer}, ` +
    `and raised ${inv}${dated} for ${f.invoiceAmount}. The Respondent accepted the goods/services on ` +
    `${f.acceptanceDate}. Under Section 15 of the MSMED Act, 2006, payment fell due on ${f.dueDate} ` +
    `(${f.paymentTermDays} days from acceptance). Status: ${f.paymentStatus}. ` +
    `The payment is overdue by ${f.overdueDays} days.`
  );
}

async function llmNarrative(facts) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_completion_tokens: 1500,
        messages: [
          {
            role: 'system',
            content:
            'You draft the "Statement of Facts" for an MSME payment-delay reference under the MSMED Act, 2006. ' +
            'Write 2 short formal paragraphs. Use ONLY the facts given in the JSON, copying amounts and dates exactly as written. ' +
            'Do not add any facts, figures, legal citations or case law. Do not calculate anything. Plain text only. ' +
            'Do not mention any agreement, contract, purchase order or terms "specified in" any document. Describe the 45-day period only as the statutory period under Section 15 of the MSMED Act, 2006.',
          },
          { role: 'user', content: JSON.stringify(facts) },
        ],
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    const amountDigits = facts.invoiceAmount.replace('₹', '').replace(/\.00$/, '');
    if (!res.ok || !text || !text.includes(amountDigits)) return null;
    if (/agreement|contract|purchase order|specified in/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

export const generateFilingHandler = async (event) => {
  let b;
  try {
    b = JSON.parse(event.body || '{}');
  } catch {
    return reply(400, { message: 'Body must be valid JSON' });
  }

  const supplier = b.supplierName || b.businessName;
  const buyer = b.buyerName || '[BUYER NAME]';
  const amount = Number(b.invoiceAmount);

  if (!supplier || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(b.acceptanceDate || '')) {
    return reply(400, {
      message: 'supplierName (or businessName), invoiceAmount and acceptanceDate (YYYY-MM-DD) are required',
    });
  }

  const paid = b.paymentReceived === true && !!b.paymentDate;

  const calc = calculateInterest({
    invoiceAmount: amount,
    acceptanceDate: b.acceptanceDate,
    paymentDate: paid ? b.paymentDate : null,
    asOf: b.asOf || null,
    agreedPaymentDays: b.agreedPaymentDays || null,
  });

  if (calc.overdueDays === 0) {
    return reply(422, {
      message: 'Payment is not overdue yet, so there is nothing to claim.',
      dueDate: calc.dueDate,
    });
  }

  const principalOutstanding = paid ? 0 : amount;
  const totalClaimed = paid ? calc.interest : calc.totalPayable;

  const facts = {
    supplier,
    buyer,
    invoiceNumber: b.invoiceNumber || null,
    invoiceDate: b.invoiceDate ? longDate(b.invoiceDate) : null,
    invoiceAmount: inr(amount),
    acceptanceDate: longDate(b.acceptanceDate),
    dueDate: longDate(calc.dueDate),
    paymentTermDays: calc.paymentTermDays,
    paymentStatus: paid
      ? `principal paid on ${longDate(b.paymentDate)}; interest for the delay remains unpaid`
      : `unpaid as of ${longDate(calc.calculatedTill)}`,
    overdueDays: calc.overdueDays,
  };

  const llmText = await llmNarrative(facts);
  const narrative = llmText || templateNarrative(facts);

  const table = calc.breakdown
    .map(
      (r) =>
        `  ${String(r.month).padStart(2)}. ${longDate(r.from)} to ${longDate(r.to)} | ` +
        `${r.days} days | ${r.interestRatePct}% p.a. on ${inr(r.principalAtStart)} = ${inr(r.interest)}`
    )
    .join('\n');

  const filingText = [
    'BEFORE THE MICRO AND SMALL ENTERPRISES FACILITATION COUNCIL',
    '[Select the Council for the Supplier\'s district/State]',
    '',
    'REFERENCE UNDER SECTION 18(1) OF THE MSMED ACT, 2006',
    '',
    `CLAIMANT (SUPPLIER): ${supplier}`,
    `Udyam Registration No.: ${b.udyamNumber || '[UDYAM NUMBER]'}`,
    `RESPONDENT (BUYER): ${buyer}`,
    `Address: ${b.buyerAddress || '[BUYER ADDRESS]'}`,
    '',
    '1. STATEMENT OF FACTS',
    narrative,
    '',
    '2. DUE DATE (SECTION 15)',
    `Date of acceptance: ${longDate(b.acceptanceDate)}. Payment term applied: ${calc.paymentTermDays} days. ` +
      `Due date: ${longDate(calc.dueDate)}.`,
    '',
    '3. INTEREST (SECTION 16)',
    `Compound interest with monthly rests at three times the RBI Bank Rate ` +
      `(Bank Rate ${calc.currentBankRatePct}%, applied rate ${calc.currentInterestRatePct}% p.a.), ` +
      `calculated till ${longDate(calc.calculatedTill)}:`,
    table,
    '',
    '4. AMOUNT CLAIMED (SECTION 17)',
    'The Respondent is liable to pay the amount due together with interest under Section 16, as provided by Section 17.',
    `Principal outstanding: ${inr(principalOutstanding)}`,
    `Interest under Section 16: ${inr(calc.interest)}`,
    `Total claimed: ${inr(totalClaimed)}`,
    'Interest continues to accrue until the date of realisation.',
    '',
    '5. RELIEF SOUGHT',
    '(a) Direct the Respondent to pay the amount claimed above.',
    '(b) Direct payment of further interest under Section 16 until realisation.',
    '(c) Conduct conciliation under Section 18(2) and, if it fails, take up or refer the dispute to arbitration under Section 18(3).',
    '(d) Award costs and any other relief the Council considers appropriate.',
    '',
    '6. DOCUMENTS TO ANNEX',
    'Invoice copy; purchase order/contract; proof of delivery or acceptance; Udyam registration certificate; ' +
      'ledger/statement of account; reminders or demand notices sent; bank statement (if part or late payment was received).',
    '',
    'VERIFICATION',
    'I verify that the contents above are true to the best of my knowledge and belief.',
    'Place: ________   Date: ________   Signature: ________',
  ].join('\n');

  return reply(200, {
    filingText,
    claim: { principalOutstanding, interest: calc.interest, totalClaimed },
    interest: calc,
    warnings: calc.warnings,
    narrativeSource: llmText ? 'llm' : 'template',
    disclaimer:
      'Draft for the claimant\'s review, not legal advice. Verify the RBI Bank Rate, the applicable Council and all facts before filing.',
  });
};