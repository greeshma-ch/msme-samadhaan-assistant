// src/handlers/extract-invoice.mjs
import { extractText, getDocumentProxy } from 'unpdf';

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

export const extractInvoiceHandler = async (event) => {
    console.log('GROQ key length:', process.env.GROQ_API_KEY?.length);

    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return reply(400, { message: 'Body must be valid JSON' });
    }
    if (!body?.file) {
        return reply(400, { message: 'Missing "file" (base64 PDF)' });
    }

    let text;
    try {
        const pdfBuffer = Buffer.from(body.file, 'base64');
        const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
        ({ text } = await extractText(pdf, { mergePages: true }));
    } catch (err) {
        return reply(422, { message: 'Could not read the PDF', detail: err.message });
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [{
                role: 'user',
                content: `Extract these fields from the invoice text as JSON only, no other text: supplierName (the seller who issued the invoice), buyerName (the customer being billed), invoiceNumber (string or null), invoiceAmount (number), invoiceDate (YYYY-MM-DD), acceptanceDate (YYYY-MM-DD), paymentReceived (boolean), paymentDate (YYYY-MM-DD or null).\n\nInvoice text:\n${text}`
            }],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_completion_tokens: 2000,
        }),
    });

    const data = await groqResponse.json();
    console.log('GROQ RESPONSE:', JSON.stringify(data));

    if (!groqResponse.ok || !data.choices?.length) {
        return reply(502, { message: 'LLM call failed', detail: data.error?.message });
    }

    let extracted;
    try {
        extracted = JSON.parse(data.choices[0].message.content);
    } catch {
        return reply(502, {
            message: 'LLM returned invalid JSON',
            raw: data.choices[0].message.content,
        });
    }

    return reply(200, extracted);
};