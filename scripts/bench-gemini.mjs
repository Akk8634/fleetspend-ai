// Time a few Gemini models on one sample bill to pick a fast, accurate one.
// Usage: node scripts/bench-gemini.mjs [image] [model ...]
import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

process.loadEnvFile('.env.local');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const [image = 'public/samples/overcharge.jpg', ...models] = process.argv.slice(2);
const list = models.length ? models : ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
const data = readFileSync(image).toString('base64');
const prompt = 'Return JSON with vendor_name, amount_text (total as printed, no symbol), currency_code, bill_date (YYYY-MM-DD), invoice_number.';

for (const model of list) {
  for (const thinking of [undefined, 'MINIMAL']) {
    const started = Date.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data } }] }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0,
          abortSignal: AbortSignal.timeout(90_000),
          ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
        },
      });
      console.log(`${model.padEnd(26)} thinking=${(thinking ?? 'default').padEnd(8)} ${String(Date.now() - started).padStart(6)} ms  ${res.text?.replace(/\s+/g, ' ').slice(0, 140)}`);
    } catch (e) {
      console.log(`${model.padEnd(26)} thinking=${(thinking ?? 'default').padEnd(8)} ${String(Date.now() - started).padStart(6)} ms  ERROR ${e.status ?? ''} ${String(e.message).slice(0, 120)}`);
    }
  }
}
