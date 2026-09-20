# MSME Samadhaan Assistant

Turn a delayed-payment invoice into an MSEFC-ready filing. The AI drafts, you review, the Council decides.

Built for **First Commit** (WeMakeDevs x AWS, Bharat Builds Tour), Build It track.

## The problem

- Delayed payments owed to MSMEs peaked at about **₹10.7 lakh crore in 2022**, and were estimated at **₹7.34 lakh crore as of March 2024**, still more than 4.6% of India's GVA ([GAME-FISME-C2FO Delayed Payments Report 3.0](https://www.the-rise.in/news/single-news.php?title=delayed-payments-to-msme-decline,-but-hurdle-remains:-game-fisme-report&id=267); [GAME](https://massentrepreneurship.org/delayed-payment-2/)).
- Under the **MSMED Act, 2006**, a buyer must pay within **45 days** of acceptance, or sooner if a written agreement says so. If they don't, they owe **compound interest with monthly rests at 3x the RBI Bank Rate**. At today's 5.50% Bank Rate, that is **16.5% p.a.**
- Every state has a **Micro and Small Enterprise Facilitation Council (MSEFC)**, and 161 have been established across States and Union Territories ([PIB](https://www.pib.gov.in/FactsheetDetails.aspx?Id=150826&reg=48&lang=2)). Under Section 18, the Council conciliates payment disputes and, if that fails, takes up arbitration.
- **Fewer than 1% of registered MSMEs have filed a complaint on Samadhaan** ([GAME](https://massentrepreneurship.org/delayed-payment-2/)). The right exists, but the paperwork and the interest calculation are hard for a business owner to do alone.
- We did not find an AI-assisted tool built around this mechanism. The gap is in access, not in the law.

## Legal basis (MSMED Act, 2006)

| Section | What it provides | Where this tool uses it |
|---|---|---|
| 15 | The buyer must pay by the date agreed in writing or, with no agreement, by the appointed day. A written agreement can never exceed **45 days** from acceptance or deemed acceptance. | Due date |
| 16 | The buyer owes **compound interest with monthly rests at three times the Bank Rate notified by the RBI**. | Interest calculation |
| 17 | The buyer is liable to pay the amount due together with the Section 16 interest. | Basis of the claim |
| 18 | Any party may refer the dispute to the MSEFC, which conciliates and, if that fails, takes up arbitration. | The reference the tool drafts |

**2026 amendment:** the MSMED (Amendment) Act, 2026 passed Parliament in August 2026 and was published in the Gazette on 13 August 2026, but its provisions take effect on dates the Central Government notifies separately ([summary](https://masllp.com/msmed-amendment-act-2026-new-msme-delayed-payment-rules-explained-simply/)). It adds an online dispute resolution mechanism, fixed timelines for mediation and arbitration, and recovery of awards as arrears of land revenue ([PIB](https://www.pib.gov.in/FactsheetDetails.aspx?Id=150826&reg=48&lang=2)). The drafts follow Sections 15 to 18 as they currently stand. Check the commencement notification before relying on any new provision.

## Expected impact

The tool aims to raise the number of eligible MSMEs that actually file. It does this by removing the two hardest steps: working out the interest, and drafting a reference the Council can act on. We have not measured any uplift yet, so this README makes no numeric claim about it.

## What it does

1. **Upload an invoice PDF** (or use the **Enter manually** tab). An AI extraction step pulls out the supplier, buyer, invoice number, amount and key dates.
2. **Review and correct** the extracted fields, and optionally add the buyer's address and the supplier's Udyam registration number. Anything left blank appears in the draft as a clearly marked placeholder to complete before filing. The person stays in control before anything is generated.
3. **Generate the filing.** The backend calculates the exact Section 16 interest (3x Bank Rate, monthly rests, counted from the day after the 45-day period ends) and drafts a reference to the Council that cites Sections 15, 16 and 18, with a month-by-month interest table. The claim summary shows principal, Section 16 interest and the total claimed, and the draft can be printed or saved as a PDF.
4. **Save the case.** Saved cases are listed in the app, with a status (for example, Draft), so the owner can come back to them.

The Council still makes the ruling. This tool only removes the paperwork barrier.

## Design decisions

- **Numbers come from code, not the LLM.** Due date, interest and totals are computed deterministically. The model only writes the "Statement of Facts" paragraph. If its output omits the correct invoice amount, mentions an agreement or contract the user never supplied, or the call fails, the backend falls back to a fixed template.
- **Honest about its limits.** Invoices from before the verified rate history show a warning instead of silently using the wrong rate.
- **Human in the loop.** Extracted fields are editable, and every draft carries a "not legal advice" disclaimer.

## Track: Build It

Runs on local tooling (SAM CLI emulating API Gateway and Lambda) rather than a live AWS deployment, keeping the build within available AWS credits.

## Architecture

- **API layer:** AWS SAM CLI, emulating API Gateway and Lambda locally (Node.js)
- **PDF text extraction:** `unpdf` (serverless-safe, no native or canvas dependencies)
- **AI extraction and narrative drafting:** `openai/gpt-oss-20b` via Groq's API (override with the `GROQ_MODEL` environment variable). A plain extract, structure, draft pipeline; no agent framework is used.
- **Interest calculation:** `src/lib/msmed-interest.mjs`, deterministic logic for Section 15 due dates and Section 16 monthly-rest compounding
- **Case storage:** DynamoDB, emulated locally with LocalStack
- **Frontend:** single-file HTML, CSS and vanilla JS client calling the local API

## API

### `POST /extract`

Request: `{ "file": "<base64 PDF>" }`

Response:

```json
{
  "supplierName": "Kavya Precision Components Pvt Ltd",
  "buyerName": "Metro Retail Solutions Pvt Ltd",
  "invoiceNumber": "INV-2026-0417",
  "invoiceAmount": 485000,
  "invoiceDate": "2026-06-10",
  "acceptanceDate": "2026-06-12",
  "paymentReceived": false,
  "paymentDate": null
}
```

### `POST /generate-filing`

Request fields: `supplierName`, `buyerName`, `buyerAddress`, `udyamNumber`, `invoiceNumber`, `invoiceAmount`, `invoiceDate`, `acceptanceDate`, `paymentReceived`, `paymentDate`, and optionally `agreedPaymentDays` (capped at 45).

Response: `filingText` (the full draft), `claim` (principal outstanding, interest, total), `interest` (due date, overdue days, month-by-month breakdown), `warnings`, `narrativeSource` (`llm` or `template`) and `disclaimer`.

Example for the sample invoice, calculated till 20 September 2026: due date 27 July 2026, 55 days overdue, interest of ₹12,132.30 at 16.5% p.a., total claimed ₹4,97,132.30. A payment that is not yet overdue returns `422`.

### Case endpoints

- `POST /` saves a case. The app sends `id`, the form fields, `status` (`Draft`), `totalClaimed` and `filingText`.
- `GET /` lists saved cases.
- `GET /{id}` returns one case.

## Updating the RBI Bank Rate

The rate lives in `BANK_RATE_HISTORY` in `src/lib/msmed-interest.mjs`. When the RBI revises the Bank Rate, append a row with its effective date and the new rate. Add earlier rows only after checking them on rbi.org.in.

## Limitations

- Only one verified Bank Rate row is included (5.50%, effective 5 December 2025). Invoices with earlier dates use that rate and show a warning.
- The Bank Rate used for each monthly rest is the one in force at the start of that month.
- PDFs must contain selectable text. Scanned image-only PDFs are not supported.
- Extraction can be wrong, so always review the fields before generating.
- Saved cases are stored in a local, emulated DynamoDB table, so they do not persist beyond your LocalStack container.

## AI coding tools used

- **Claude (Anthropic):** architecture design, environment setup and debugging, including LocalStack container networking (`host.docker.internal`), a Windows path-length build failure, a PDF-parsing library incompatibility with Lambda's runtime, CORS and YAML configuration issues, the Groq model and API key configuration, and code review across the handler functions.

## Setup and run locally

**Prerequisites:** Docker Desktop, Node.js, AWS SAM CLI, and a free Groq API key from [console.groq.com](https://console.groq.com).

**Never commit your Groq key.** It is passed at startup and stored in no file.

```bash
sam build
sam local start-api --port 3000 --parameter-overrides GroqApiKey=<your_groq_key>
```

Then open `frontend/index.html` in a browser. There is no build step.

### LocalStack and DynamoDB (case storage)

Run LocalStack and create the table before using **Save case**:

```bash
# Git Bash
docker run -d -p 4566:4566 -e LOCALSTACK_AUTH_TOKEN=<your_token> -v //var/run/docker.sock:/var/run/docker.sock --name localstack localstack/localstack
```

```powershell
# PowerShell
docker run -d -p 4566:4566 -e LOCALSTACK_AUTH_TOKEN=<your_token> -v /var/run/docker.sock:/var/run/docker.sock --name localstack localstack/localstack
```

```bash
aws dynamodb create-table --table-name SampleTable --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST --endpoint-url http://localhost:4566
sam local start-api --port 3000 --env-vars env.json --parameter-overrides GroqApiKey=<your_groq_key>
```

## Disclaimer

Filing drafts generated by this tool are **estimates for the claimant's review, not legal advice**. Verify the current RBI Bank Rate, the applicable MSEFC, and all case facts before filing.
