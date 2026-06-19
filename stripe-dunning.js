// FSL Tuition Dunning Relay
// Stripe  ->  this relay (verify + filter)  ->  GHL inbound webhook
//
// Env vars required in Vercel:
//   STRIPE_WEBHOOK_SECRET  (test-mode signing secret first, live later)
//   GHL_WEBHOOK_URL        (your GHL Inbound Webhook trigger URL)

import Stripe from "stripe";

// We need the raw body to verify Stripe's signature, so disable Vercel's
// automatic JSON body parsing for this route.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Read the raw request body as a buffer
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Only these Stripe events matter to the dunning workflow
const RELEVANT_EVENTS = new Set([
  "invoice.payment_failed",   // a retry (or first charge) failed
  "invoice.paid",             // the invoice got paid -> recovery
  "invoice.payment_succeeded" // belt-and-suspenders recovery signal
]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_placeholder", {
    apiVersion: "2024-06-20",
  });

  const sig = req.headers["stripe-signature"];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // Signature failed -> reject. Protects against spoofed calls.
    console.error("Signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Ignore everything we do not care about, but return 200 so Stripe
  // does not keep retrying delivery of irrelevant events.
  if (!RELEVANT_EVENTS.has(event.type)) {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const invoice = event.data.object;

  // Normalize recovery vs failure into one clean signal for GHL.
  const isRecovery =
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_succeeded";

  const payload = {
    email: invoice.customer_email || "",
    event: isRecovery ? "payment_recovered" : "payment_failed",
    attempt_count: invoice.attempt_count || 0,
    amount_due: ((invoice.amount_due || 0) / 100).toFixed(2),
    hosted_invoice_url: invoice.hosted_invoice_url || "",
    next_attempt: invoice.next_payment_attempt
      ? new Date(invoice.next_payment_attempt * 1000)
          .toISOString()
          .split("T")[0]
      : "",
    subscription_id:
      typeof invoice.subscription === "string" ? invoice.subscription : "",
  };

  // Forward to GHL
  try {
    const ghlRes = await fetch(process.env.GHL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!ghlRes.ok) {
      console.error("GHL forward failed:", ghlRes.status, await ghlRes.text());
      return res.status(502).json({ error: "GHL forward failed" });
    }
  } catch (err) {
    console.error("GHL forward error:", err.message);
    return res.status(502).json({ error: "GHL forward error" });
  }

  return res.status(200).json({ received: true, forwarded: payload.event });
}
