// FSL Tuition Dunning Relay
// Stripe  ->  this relay (verify + filter)  ->  GHL inbound webhook
//
// Env vars required in Vercel:
//   STRIPE_SECRET_KEY      (sk_test_... first, live later)
//   STRIPE_WEBHOOK_SECRET  (whsec_... signing secret, test first, live later)
//   GHL_WEBHOOK_URL        (your GHL Inbound Webhook trigger URL)

const Stripe = require("stripe");

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const RELEVANT_EVENTS = new Set([
  "invoice.payment_failed",
  "invoice.paid",
  "invoice.payment_succeeded",
]);

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ status: "FSL dunning relay is live" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_placeholder");

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
    console.error("Signature verification failed:", err.message);
    return res.status(400).send("Webhook Error: " + err.message);
  }

  if (!RELEVANT_EVENTS.has(event.type)) {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const invoice = event.data.object;

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
      ? new Date(invoice.next_payment_attempt * 1000).toISOString().split("T")[0]
      : "",
    subscription_id:
      typeof invoice.subscription === "string" ? invoice.subscription : "",
  };

  try {
    const ghlRes = await fetch(process.env.GHL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!ghlRes.ok) {
      const text = await ghlRes.text();
      console.error("GHL forward failed:", ghlRes.status, text);
      return res.status(502).json({ error: "GHL forward failed" });
    }
  } catch (err) {
    console.error("GHL forward error:", err.message);
    return res.status(502).json({ error: "GHL forward error" });
  }

  return res.status(200).json({ received: true, forwarded: payload.event });
}

module.exports = handler;
module.exports.config = {
  api: { bodyParser: false },
};
