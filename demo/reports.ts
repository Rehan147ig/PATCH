import Stripe from 'stripe';

export async function fetchRecentCharges(stripe: Stripe, customerId: string) {
  const charges = await stripe.charges.list({ customer: customerId, limit: 25 });
  return charges.data.map((charge) => ({
    id: charge.id,
    amount: charge.amount,
    currency: charge.currency,
    status: charge.status,
  }));
}

export async function summarizeTotals(stripe: Stripe) {
  const charges = await stripe.charges.list({ limit: 100 });
  const total = charges.data.reduce((sum, c) => sum + c.amount, 0);
  return { count: charges.data.length, total };
}
