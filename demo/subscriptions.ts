import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export interface SubscriptionRequest {
  customer: string;
  plan: string;
  sku?: string;
}

export async function subscribe(req: SubscriptionRequest) {
  return stripe.subscriptions.create({
    customer: req.customer,
    items: [{ plan: req.plan }],
    ...(req.sku ? { sku: req.sku } : {}),
  });
}

export async function createPaymentIntent(amountCents: number, customer: string) {
  return stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    customer,
  });
}
