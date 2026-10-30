const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ maxInstances: 10 });

const PAYFAST_MERCHANT_ID = defineSecret("PAYFAST_MERCHANT_ID");
const PAYFAST_MERCHANT_KEY = defineSecret("PAYFAST_MERCHANT_KEY");
const PAYFAST_PASSPHRASE = defineSecret("PAYFAST_PASSPHRASE");

const SANDBOX = true;
const PAYFAST_PROCESS_URL = SANDBOX
  ? "https://sandbox.payfast.co.za/eng/process"
  : "https://www.payfast.co.za/eng/process";
const PAYFAST_VALIDATE_URL = SANDBOX
  ? "https://sandbox.payfast.co.za/eng/query/validate"
  : "https://www.payfast.co.za/eng/query/validate";
const SITE_URL = "https://studyflix-membership.web.app";

const PLANS = Object.freeze({
  "standard-monthly": {
    name: "StudyFlix Student Membership",
    amount: 100,
    frequency: 3
  },
  "standard-annual": {
    name: "StudyFlix Student Membership",
    amount: 1200,
    frequency: 6
  },
  "plus-data-monthly": {
    name: "StudyFlix Student Membership + Data",
    amount: 300,
    frequency: 3
  },
  "plus-data-annual": {
    name: "StudyFlix Student Membership + Data",
    amount: 3600,
    frequency: 6
  }
});


function signPayfastFields(fields, passphrase) {
  const fieldOrder = [
    "merchant_id",
    "merchant_key",
    "return_url",
    "cancel_url",
    "notify_url",
    "notify_method",
    "name_first",
    "name_last",
    "email_address",
    "cell_number",
    "m_payment_id",
    "amount",
    "item_name",
    "item_description",
    "custom_int1",
    "custom_int2",
    "custom_int3",
    "custom_int4",
    "custom_int5",
    "custom_str1",
    "custom_str2",
    "custom_str3",
    "custom_str4",
    "custom_str5",
    "email_confirmation",
    "confirmation_address",
    "currency",
    "payment_method",
    "subscription_type",
    "billing_date",
    "recurring_amount",
    "frequency",
    "cycles",
    "subscription_notify_email",
    "subscription_notify_webhook",
    "subscription_notify_buyer"
  ];

  const encode = value =>
    encodeURIComponent(String(value).trim())
      .replace(/[!'()*]/g, ch =>
        "%" + ch.charCodeAt(0).toString(16).toUpperCase()
      )
      .replace(/%20/g, "+");

  const parts = [];

  for (const key of fieldOrder) {
    if (!(key in fields)) continue;

    const value = String(fields[key]).trim();
    if (value === "") continue;

    parts.push(`${key}=${encode(value)}`);
  }

  if (passphrase !== undefined && passphrase !== null &&
      String(passphrase).trim() !== "") {
    parts.push(`passphrase=${encode(passphrase)}`);
  }

  return crypto.createHash("md5")
    .update(parts.join("&"))
    .digest("hex");
}


function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function parseAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

async function requireFirebaseUser(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    const error = new Error("Please sign in before starting payment.");
    error.status = 401;
    throw error;
  }
  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch {
    const error = new Error("Your sign-in session is invalid. Please sign in again.");
    error.status = 401;
    throw error;
  }
}

exports.createPayfastPayment = onRequest(
  {
    secrets: [PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE],
    cors: [
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "https://studyflix-membership.web.app"
    ],
    maxInstances: 5
  },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "POST required." });

    try {
      const user = await requireFirebaseUser(req);
      const planKey = req.body && req.body.planKey;
      const plan = PLANS[planKey];
      if (!plan) return res.status(400).json({ error: "Please select a valid membership plan." });

      const memberRef = db.collection("members").doc(user.uid);
      const memberSnap = await memberRef.get();
      if (!memberSnap.exists) {
        return res.status(404).json({ error: "Submit your membership application before paying." });
      }
      const member = memberSnap.data() || {};
      if (member.email && user.email && member.email.toLowerCase() !== user.email.toLowerCase()) {
        return res.status(403).json({ error: "The signed-in account does not match this application." });
      }

      // Prices and billing periods come only from the trusted server-side plan map.
      const price = plan.amount;
      const paymentRef = db.collection("payments").doc();
      const paymentId = paymentRef.id;
      const firstName = String(member.application?.firstName || member.name || "").trim().split(/\s+/)[0].slice(0, 100);
      const lastName = String(member.application?.lastName || member.name || "").trim().split(/\s+/).slice(1).join(" ").slice(0, 100);
      const email = String(user.email || member.email || "").trim().slice(0, 100);

      const fields = {
        merchant_id: PAYFAST_MERCHANT_ID.value(),
        merchant_key: PAYFAST_MERCHANT_KEY.value(),
        return_url: `${SITE_URL}/member/membership-application.html?payment=return`,
        cancel_url: `${SITE_URL}/member/membership-application.html?payment=cancelled`,
        notify_url: `${SITE_URL}/api/payfast-webhook`,
        name_first: firstName,
        name_last: lastName,
        email_address: email,
        m_payment_id: paymentId,
        amount: price.toFixed(2),
        item_name: plan.name.slice(0, 100),
        item_description: `${planKey} StudyFlix membership`.slice(0, 255),
        custom_str1: user.uid,
        custom_str2: planKey,
        subscription_type: "1",
        recurring_amount: price.toFixed(2),
        frequency: String(plan.frequency),
        cycles: "0",
        subscription_notify_email: "true",
        subscription_notify_webhook: "true",
        subscription_notify_buyer: "true"
      };
      fields.signature = signPayfastFields(fields, PAYFAST_PASSPHRASE.value());

      await paymentRef.set({
        paymentId,
        uid: user.uid,
        provider: "payfast",
        environment: SANDBOX ? "sandbox" : "live",
        planKey,
        planName: plan.name,
        amountZAR: price,
        currency: "ZAR",
        billingPeriod: plan.frequency === 6 ? "annual" : "monthly",
        paymentStatus: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await memberRef.set({
        paymentProvider: "payfast",
        payfastPaymentId: paymentId,
        payfastStatus: "PENDING",
        membershipPlanKey: planKey,
        membershipType: plan.name,
        plan: plan.name,
        billingPeriod: plan.frequency === 6 ? "annual" : "monthly",
        membershipBillingPeriod: plan.frequency === 6 ? "annual" : "monthly",
        membershipPriceZAR: price,
        paid: false
      }, { merge: true });

      return res.status(200).json({ action: PAYFAST_PROCESS_URL, fields });
    } catch (error) {
      logger.error("Could not create PayFast checkout", { message: error.message });
      return res.status(error.status || 500).json({
        error: error.status ? error.message : "Could not prepare payment. Please try again."
      });
    }
  }
);

exports.payfastWebhook = onRequest(
  {
    secrets: [PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE],
    cors: false,
    maxInstances: 5
  },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("POST required.");

    logger.info("PayFast ITN request received", {
      contentType: req.get("content-type") || "unknown",
      bodyIsObject: !!req.body && typeof req.body === "object",
      bodyIsBuffer: Buffer.isBuffer(req.body)
    });

    try {
      const data = req.body && typeof req.body === "object" ? req.body : {};
      if (!data.signature || !data.m_payment_id || !data.payment_status) {
        return res.status(400).send("Missing required ITN fields.");
      }

      const expectedSignature = signPayfastFields(data, PAYFAST_PASSPHRASE.value());
      if (!safeEqualHex(expectedSignature, String(data.signature))) {
        logger.warn("Rejected PayFast ITN with invalid signature.");
        return res.status(400).send("Invalid signature.");
      }

      // Ask PayFast to validate the complete posted notification server-to-server.
      const validationBody = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null && typeof value !== "object") {
          validationBody.append(key, String(value));
        }
      }
      const validationResponse = await fetch(PAYFAST_VALIDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: validationBody.toString()
      });
      const validationText = (await validationResponse.text()).trim();
      if (!validationResponse.ok || validationText !== "VALID") {
        logger.warn("PayFast ITN server validation failed", { status: validationResponse.status });
        return res.status(400).send("PayFast validation failed.");
      }

      if (String(data.merchant_id) !== String(PAYFAST_MERCHANT_ID.value())) {
        return res.status(400).send("Merchant mismatch.");
      }

      const paymentRef = db.collection("payments").doc(String(data.m_payment_id));
      const paymentSnap = await paymentRef.get();
      if (!paymentSnap.exists) {
        logger.warn("PayFast ITN references unknown payment", { paymentId: String(data.m_payment_id) });
        return res.status(404).send("Unknown payment.");
      }
      const payment = paymentSnap.data();
      const plan = PLANS[payment.planKey];
      if (!plan || parseAmount(data.amount_gross) !== Math.round(payment.amountZAR * 100)) {
        logger.warn("PayFast ITN amount or plan mismatch", { paymentId: payment.paymentId });
        return res.status(400).send("Amount mismatch.");
      }
      if (String(data.custom_str1 || "") !== String(payment.uid) ||
          String(data.custom_str2 || "") !== String(payment.planKey)) {
        return res.status(400).send("Member or plan mismatch.");
      }

      const eventId = String(data.pf_payment_id || data.m_payment_id);
      const eventRef = db.collection("payfastEvents").doc(eventId);
      const memberRef = db.collection("members").doc(payment.uid);
      const status = String(data.payment_status).toUpperCase();

      await db.runTransaction(async transaction => {
        const [freshPayment, eventSnap] = await Promise.all([
          transaction.get(paymentRef),
          transaction.get(eventRef)
        ]);
        if (eventSnap.exists) return;

        const eventRecord = {
          provider: "payfast",
          eventId,
          paymentId: payment.paymentId,
          paymentStatus: status,
          processedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (status === "COMPLETE") {
          transaction.set(paymentRef, {
            paymentStatus: "paid",
            pfPaymentId: String(data.pf_payment_id || ""),
            payfastToken: String(data.token || ""),
            amountGross: Number(data.amount_gross),
            amountFee: Number(data.amount_fee || 0),
            amountNet: Number(data.amount_net || 0),
            completedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          // Payment confirmation does not approve or activate the membership.
          transaction.set(memberRef, {
            paid: true,
            paymentProvider: "payfast",
            payfastStatus: "COMPLETE",
            payfastPaymentId: payment.paymentId,
            payfastTransactionId: String(data.pf_payment_id || ""),
            payfastToken: String(data.token || ""),
            payfastUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            membershipPlanKey: payment.planKey,
            membershipType: plan.name,
            plan: plan.name,
            membershipPriceZAR: payment.amountZAR,
            billingPeriod: payment.billingPeriod,
            membershipBillingPeriod: payment.billingPeriod
          }, { merge: true });
        } else if (status === "FAILED" || status === "CANCELLED") {
          transaction.set(paymentRef, {
            paymentStatus: status.toLowerCase(),
            lastNotificationAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          transaction.set(memberRef, {
            payfastStatus: status,
            payfastUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else {
          transaction.set(paymentRef, {
            lastNotificationStatus: status,
            lastNotificationAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }

        transaction.create(eventRef, eventRecord);
      });

      return res.status(200).send("OK");
    } catch (error) {
      logger.error("PayFast ITN processing failed", { message: error.message });
      return res.status(500).send("ITN processing failed.");
    }
  }
);
