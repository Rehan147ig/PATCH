import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
});

export async function createCharge(amountCents: number, currency: string, paymentMethod: string) {
  return stripe.charges.create({
    amount: amountCents,
    currency,
    source: paymentMethod,
    description: 'Test charge',
  });
}

export async function refundCharge(chargeId: string, amountCents?: number) {
  return stripe.refunds.create({
    charge: chargeId,
    ...(amountCents ? { amount: amountCents } : {}),
  });
}

export async function listSkus() {
  return stripe.skus.list({ limit: 10 });
}

export async function getSku(skuId: string) {
  return stripe.skus.retrieve(skuId);
}
