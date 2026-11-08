import { centsToPayPalValue } from './amount';

export const PAYER_NAME = 'Ridgeway Fleet Services';

export type PayoutItemInput = {
  id: string; // our payout item id -> sender_item_id
  receiver_email: string;
  amount_minor_units: number;
  currency_code: 'USD';
  note: string;
};

export type PayPalPayoutRequest = {
  sender_batch_header: { sender_batch_id: string; email_subject: string; email_message: string };
  items: {
    recipient_type: 'EMAIL';
    amount: { value: string; currency: string };
    receiver: string;
    note: string;
    sender_item_id: string;
  }[];
};

/** Pure: build the PayPal Create Payout body for one batch (Requirement 2.1, 2.2). */
export function buildPayoutRequest(batchId: string, items: readonly PayoutItemInput[]): PayPalPayoutRequest {
  if (items.length === 0) throw new Error('A payout batch needs at least one item');
  return {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: `You have a payment from ${PAYER_NAME}`,
      email_message: `${PAYER_NAME} has paid your bill via FleetSpend AI.`,
    },
    items: items.map((item) => ({
      recipient_type: 'EMAIL',
      amount: { value: centsToPayPalValue(item.amount_minor_units), currency: item.currency_code },
      receiver: item.receiver_email,
      note: item.note.slice(0, 4000),
      sender_item_id: item.id,
    })),
  };
}
