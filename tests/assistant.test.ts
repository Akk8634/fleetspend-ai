import { describe, expect, it, vi } from 'vitest';
import { AssistantInputError, AssistantUnavailableError, planPayment, type PlanDeps } from '../lib/assistant/planPayment';
import { buildCriteriaPrompt, weekRange } from '../lib/assistant/prompt';
import type { PlanBill } from '../lib/assistant/planEngine';

const bills: PlanBill[] = [
  { id: 'fuel-ready', status: 'ready', vendor_name: 'Apex Fuel Co', invoice_number: 'APX-104', bill_date: '2026-11-04', amount_minor_units: 21000, category: 'fuel', payee_email: 'a@x', flags: [] },
  { id: 'fuel-flagged', status: 'flagged', vendor_name: 'Apex Fuel Co', invoice_number: 'APX-105', bill_date: '2026-11-05', amount_minor_units: 45000, category: 'fuel', payee_email: 'a@x', flags: [{ check_name: 'overcharge', reason: 'x' }] },
];

const deps = (reply: string | Error | (() => Promise<string>), over: Partial<PlanDeps> = {}): PlanDeps => ({
  listPayableBills: async () => bills,
  listVendorNames: async () => ['Apex Fuel Co', 'Metro Auto Repair'],
  generateCriteria: vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply();
    return reply;
  }),
  today: '2026-11-08',
  timeoutMs: 50,
  ...over,
});

const plan = (o: object) =>
  JSON.stringify({ intent: 'plan', include_flagged: false, include_failed: false, summary: 'Fuel bills this week', ...o });

describe('planPayment', () => {
  it('turns criteria into a plan without letting the AI pick bills', async () => {
    const r = await planPayment('Pay all clean fuel bills from this week',
      deps(plan({ categories: ['fuel'], date_from: '2026-11-02', date_to: '2026-11-08', bill_ids: ['fuel-flagged'], amount: '9999' })));
    expect(r.kind).toBe('plan');
    if (r.kind !== 'plan') return;
    expect(r.plan.included.map((i) => i.billId)).toEqual(['fuel-ready']); // bill_ids from the AI were ignored
    expect(r.plan.criteria).not.toHaveProperty('bill_ids');
    expect(r.chips).toContain('Clean bills only');
    expect(r.instruction).toBe('Pay all clean fuel bills from this week');
  });

  it('returns the clarification question when the AI is unsure', async () => {
    const r = await planPayment("what's the weather?", deps(JSON.stringify({ intent: 'clarify', clarification_question: 'Which bills should I pay?', include_flagged: false, include_failed: false, summary: 'n/a' })));
    expect(r).toEqual({ kind: 'clarify', question: 'Which bills should I pay?', instruction: "what's the weather?" });
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['schema violation', JSON.stringify({ intent: 'plan', summary: '' })],
    ['bad date', plan({ date_from: '2026-02-30' })],
    ['service error', new Error('503')],
  ])('%s -> friendly AssistantUnavailableError', async (_l, reply) => {
    const err = await planPayment('Pay fuel bills', deps(reply as string | Error)).catch((e) => e);
    expect(err).toBeInstanceOf(AssistantUnavailableError);
    expect(err.message).toContain('Try rephrasing');
  });

  it('times out slow AI calls', async () => {
    const err = await planPayment('Pay fuel bills', deps(() => new Promise(() => {}))).catch((e) => e);
    expect(err).toBeInstanceOf(AssistantUnavailableError);
    expect(err.detail).toContain('timed out');
  });

  it.each(['', 'hi', 'x'.repeat(301), 42])('rejects instruction %j', async (input) => {
    await expect(planPayment(input, deps(plan({})))).rejects.toBeInstanceOf(AssistantInputError);
  });
});

describe('prompt', () => {
  it('computes Monday..Sunday for "this week"', () => {
    expect(weekRange('2026-11-08')).toEqual({ from: '2026-11-02', to: '2026-11-08' }); // Sunday
    expect(weekRange('2026-11-09')).toEqual({ from: '2026-11-09', to: '2026-11-15' }); // Monday
  });
  it('includes today, the week, the vendors, and the no-bill-ids rule', () => {
    const p = buildCriteriaPrompt({ instruction: 'Pay fuel', today: '2026-11-08', vendorNames: ['Apex Fuel Co'] });
    expect(p).toContain('Today is 2026-11-08');
    expect(p).toContain('2026-11-02 to 2026-11-08');
    expect(p).toContain('Apex Fuel Co');
    expect(p).toContain('Never output bill ids');
  });
});
