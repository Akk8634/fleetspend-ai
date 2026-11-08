// Records the FleetSpend AI demo on the live site with captions; writes timeline.json for the audio mix.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const BASE = 'https://fleetspend-ai.vercel.app';
const narration = JSON.parse(readFileSync('narration.json', 'utf8'));
const durations = JSON.parse(readFileSync('durations.json', 'utf8'));
const byId = Object.fromEntries(narration.map((n) => [n.id, n]));

// Fresh demo before recording (not shown).
const reset = await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });
console.log('reset', reset.status, await reset.text());

rmSync('rec', { recursive: true, force: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: 'rec', size: { width: 1280, height: 720 } },
});

await context.addInitScript(() => {
  const css = `
    #demo-cap{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:1080px;width:max-content;
      background:rgba(15,23,42,.92);color:#fff;font:600 19px/1.35 system-ui,Segoe UI,sans-serif;padding:10px 18px;border-radius:12px;
      box-shadow:0 8px 30px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center;transition:opacity .25s;pointer-events:none}
    #demo-cap *,#demo-speed{pointer-events:none}
    #demo-cap .tag{font:600 11px/1 system-ui;letter-spacing:.04em;text-transform:uppercase;background:#4f46e5;padding:5px 7px;border-radius:6px;white-space:nowrap}
    #demo-speed{position:fixed;top:14px;right:16px;z-index:2147483647;background:#f59e0b;color:#111;font:700 15px system-ui;padding:6px 10px;border-radius:8px;display:none}
    .demo-hl{outline:4px solid #f59e0b !important;outline-offset:3px !important;border-radius:8px;transition:outline .2s}`;
  const ensure = () => {
    if (document.getElementById('demo-cap') || !document.body) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const cap = document.createElement('div'); cap.id = 'demo-cap'; cap.style.opacity = '0'; document.body.appendChild(cap);
    const sp = document.createElement('div'); sp.id = 'demo-speed'; sp.textContent = '⏩ 4× speed'; document.body.appendChild(sp);
  };
  window.__cap = (text, pos = 'bottom') => {
    ensure();
    const cap = document.getElementById('demo-cap');
    if (!text) { cap.style.opacity = '0'; return; }
    cap.innerHTML = `<span class="tag">AI voice</span><span></span>`;
    cap.lastChild.textContent = text;
    cap.style.top = pos === 'top' ? '76px' : 'auto';
    cap.style.bottom = pos === 'top' ? 'auto' : '22px';
    cap.style.opacity = '1';
  };
  window.__speed = (on) => { ensure(); document.getElementById('demo-speed').style.display = on ? 'block' : 'none'; };
  document.addEventListener('DOMContentLoaded', ensure);
});

const page = await context.newPage();
const t0 = Date.now();
const now = () => Date.now() - t0;
const timeline = { scenes: [], fast: [] };
const sleep = (ms) => page.waitForTimeout(ms);
page.on('dialog', (d) => d.accept());

let capState = { text: '', pos: 'bottom' };
const cap = async (text, pos = 'bottom') => { capState = { text, pos }; await page.evaluate(([t, p]) => window.__cap?.(t, p), [text, pos]).catch(() => {}); };
page.on('load', () => page.evaluate(([t, p]) => window.__cap?.(t, p), [capState.text, capState.pos]).catch(() => {}));

async function hl(locator, ms = 700) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.evaluate((el) => el.classList.add('demo-hl')).catch(() => {});
  await sleep(ms);
  await locator.evaluate((el) => el.classList.remove('demo-hl')).catch(() => {});
}
async function scrollToEl(selectorOrLocator, offset = 80) {
  const loc = typeof selectorOrLocator === 'string' ? page.locator(selectorOrLocator) : selectorOrLocator;
  await loc.first().evaluate((el, off) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'smooth' }), offset);
  await sleep(900);
}

/** Run a scene: caption + narration mark, actions, then hold until the narration has finished. */
async function scene(id, actions, { pos = 'bottom', tail = 500 } = {}) {
  const start = now();
  timeline.scenes.push({ id, atMs: start, durMs: durations[id] });
  console.log(`[${(start / 1000).toFixed(1)}s] ${id}`);
  await cap(byId[id].caption, pos);
  await actions();
  const left = durations[id] + tail - (now() - start);
  if (left > 0) await sleep(left);
}

const card = (title, subtitle, bullets, foot) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#eef2ff,#f8fafc 55%,#e0f2fe);font-family:'Segoe UI',system-ui,sans-serif;color:#0f172a}
  .w{max-width:980px;padding:40px}.logo{display:flex;align-items:center;gap:14px;margin-bottom:22px}
  .b{width:56px;height:56px;border-radius:14px;background:#4f46e5;color:#fff;display:grid;place-items:center;font:700 22px system-ui}
  h1{font-size:46px;margin:0}h2{font-size:24px;font-weight:500;color:#334155;margin:6px 0 26px;line-height:1.35}
  ul{margin:0;padding:0;list-style:none;display:grid;gap:12px}li{font-size:21px;display:flex;gap:12px}li:before{content:'✓';color:#059669;font-weight:700}
  .f{margin-top:30px;font-size:16px;color:#475569}</style></head><body><div class="w">
  <div class="logo"><div class="b">FS</div><h1>${title}</h1></div><h2>${subtitle}</h2><ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>
  <div class="f">${foot}</div></div></body></html>`;

// ---------------------------------------------------------------- 1. title
await page.setContent(card('FleetSpend AI', 'An AI accounts-payable agent for small fleet businesses', [
  'Reads every bill with Gemini — photos or PDFs',
  'Catches duplicates, overcharges, new payees and over-limit bills',
  'Pays vendors with <b>PayPal Payouts</b> — only after a human approves',
], 'PayPal AI Hackathon · live demo on PayPal sandbox · fleetspend-ai.vercel.app'));
await scene('s1_intro', async () => {});

// ---------------------------------------------------------------- 2. upload + process
await page.goto(BASE, { waitUntil: 'networkidle' });
await cap('', 'bottom');
await sleep(800);
await scene('s2_upload', async () => {
  const btn = page.getByRole('button', { name: 'Try the 8 sample bills' });
  await hl(btn);
  await btn.click();
  await sleep(2500);
  await page.evaluate(() => window.scrollTo({ top: 180, behavior: 'smooth' }));
});
await scene('s3_checks', async () => {});

// silent wait until processing finishes -> fast-forwarded later
const fastStart = now();
await page.evaluate(() => window.__speed(true));
await cap('Processing the remaining bills…', 'bottom');
await page.getByText('Upload finished', { exact: false }).waitFor({ timeout: 180_000 });
await sleep(1200);
await page.evaluate(() => window.__speed(false));
timeline.fast.push({ fromMs: fastStart, toMs: now(), factor: 4 });

// ---------------------------------------------------------------- 3. results in the AG Grid
await scene('s4_results', async () => {
  await scrollToEl('#bills-heading', 20);
  await sleep(1500);
  const flagged = page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: /^Flagged/ });
  await hl(flagged, 600);
  await flagged.click();
  await sleep(5200);
  const all = page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: /^All/ });
  await all.click();
});

// ---------------------------------------------------------------- 4. review the unsure bill
await scene('s5_review', async () => {
  const review = page.getByRole('link', { name: 'Review', exact: true }).first();
  await hl(review, 600);
  await review.click();
  await page.waitForURL(/\/review$/);
  await page.locator('#amount').waitFor();
  await sleep(2200);
  await hl(page.locator('#amount'), 500);
  await page.locator('#amount').fill('378.50');
  await page.locator('#bill_date').fill('2026-11-07');
  await sleep(900);
  const save = page.getByRole('button', { name: 'Save and run checks' });
  await hl(save, 500);
  await save.click();
  await page.waitForURL(BASE + '/', { timeout: 60_000 });
  await page.waitForLoadState('networkidle');
});

// ---------------------------------------------------------------- 5. assistant
await scene('s6_assistant', async () => {
  await scrollToEl('#assistant-heading', 90);
  const ex = page.getByRole('button', { name: 'Pay all Apex Fuel bills, including flagged ones' });
  await hl(ex, 700);
  await ex.click();
  await page.getByRole('button', { name: 'Review & approve' }).waitFor({ timeout: 40_000 });
  await scrollToEl('#assistant-heading', 20);
});

// ---------------------------------------------------------------- 6. approve
await scene('s7_approve', async () => {
  const go = page.getByRole('button', { name: 'Review & approve' });
  await hl(go, 500);
  await go.click();
  const reason = page.locator('textarea[id^="reason-"]');
  await reason.waitFor();
  await sleep(1200);
  await reason.pressSequentially('Called Apex: diesel price rose this week, confirmed.', { delay: 28 });
}, { pos: 'top' });

// ---------------------------------------------------------------- 7. PayPal
await scene('s8_paypal', async () => {
  const pay = page.getByRole('button', { name: /^Pay \$.* with PayPal$/ });
  await hl(pay, 600);
  await pay.click();
  await page.locator('#payments-heading').waitFor();
  await sleep(1500);
  await scrollToEl('#payments-heading', 260);
}, { pos: 'top' });

// silent wait for PayPal -> fast-forwarded, then narrate the confirmed result
const fast2 = now();
await page.evaluate(() => window.__speed(true));
await cap('Waiting for PayPal to confirm…', 'top');
await page.getByText('Completed').first().waitFor({ timeout: 90_000 }).catch(() => console.log('Completed not seen yet'));
await page.evaluate(() => window.__speed(false));
timeline.fast.push({ fromMs: fast2, toMs: now(), factor: 4 });
await scene('s8b_paid', async () => {
  await scrollToEl('#bills-heading', 20);
}, { pos: 'top' });

// ---------------------------------------------------------------- 8. closing
await cap('', 'bottom');
await page.setContent(card('FleetSpend AI', 'AI reads, checks and suggests. A human approves. PayPal pays.', [
  'The AI never moves money — it returns selection rules, code picks the bills',
  'Never pays twice: state machine + unique live payout per bill + PayPal-Request-Id',
  'Every approval, override reason and PayPal result in an append-only audit log',
  '205 automated tests, incl. 13 property-based checks for money and safety',
], 'Next.js · Gemini · Supabase · AG Grid · PayPal Payouts &nbsp;|&nbsp; fleetspend-ai.vercel.app &nbsp;|&nbsp; github.com/Akk8634/fleetspend-ai'));
await scene('s9_close', async () => {}, { tail: 1200 });

const video = page.video();
await context.close();
timeline.endMs = now();
timeline.video = await video.path();
writeFileSync('timeline.json', JSON.stringify(timeline, null, 1));
await browser.close();
console.log('done', timeline.video, (timeline.endMs / 1000).toFixed(1) + 's');
