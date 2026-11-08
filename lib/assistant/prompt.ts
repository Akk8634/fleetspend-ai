import { CATEGORIES } from '../ai/extractionSchema';

/** Monday..Sunday (UTC) of the week containing `today` (YYYY-MM-DD). */
export function weekRange(today: string): { from: string; to: string } {
  const d = new Date(`${today}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(d.getTime() - offset * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

export function buildCriteriaPrompt(args: { instruction: string; today: string; vendorNames: string[] }): string {
  const week = weekRange(args.today);
  return `You help a small fleet business owner decide which bills to pay. Convert the owner's instruction into
selection criteria as JSON. You do NOT choose bills, amounts or payees and you never pay anything:
code applies your criteria and the owner approves every payment.

Today is ${args.today}. "This week" means ${week.from} to ${week.to} (Monday to Sunday).
Known vendors: ${args.vendorNames.length ? args.vendorNames.join('; ') : '(none)'}.
Bill categories: ${CATEGORIES.join(', ')} (driver_trip = driver pay / trips).

Rules:
- intent = "plan" when the instruction is about paying bills; otherwise, or if it is ambiguous, intent = "clarify"
  and ask one short question in clarification_question.
- vendor_names: only vendors the owner named, spelled like the known vendors. Empty list = any vendor.
- categories: only if the owner mentioned a kind of bill (fuel, repairs, parts, drivers...). Empty list = any.
- date_from / date_to: inclusive YYYY-MM-DD, resolved from relative words like "this week" or "last month". null = no limit.
- max_amount_per_bill / max_total: decimal USD text like "500.00" when the owner gives a limit, else null.
- include_flagged = true ONLY if the owner explicitly asks to include flagged / risky / all bills, including flagged ones.
  "clean", "safe", "ready" or no mention means false.
- include_failed = true only if the owner asks to retry failed payments.
- summary: one short sentence restating what will be selected, in plain English.
- Never output bill ids, emails or amounts to pay.

Owner instruction: """${args.instruction.replace(/"""/g, '"')}"""`;
}
