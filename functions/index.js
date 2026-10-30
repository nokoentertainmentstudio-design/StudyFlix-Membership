
const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();



setGlobalOptions({
  maxInstances: 10
});



const PAYPAL_CLIENT_ID =
  defineSecret("PAYPAL_CLIENT_ID");

const PAYPAL_CLIENT_SECRET =
  defineSecret("PAYPAL_CLIENT_SECRET");

const PAYPAL_WEBHOOK_ID =
  defineSecret("PAYPAL_WEBHOOK_ID");



const PAYPAL_API =
  "https://api-m.paypal.com";



const PLAN_NAMES = {

  "P-4M207833SW0061541NKYOBQQ":
    "StudyFlix Student Membership",

  "P-6GK41801196058811NK6QNTI":
    "StudyFlix Student Membership",

  "P-68800109GT083772LNKYOFPA":
    "StudyFlix Student Membership + Data",

  "P-76Y177913D3206319NK6QV2A":
    "StudyFlix Student Membership + Data"

};



const PLAN_KEYS = {

  "P-4M207833SW0061541NKYOBQQ":
    "standard-monthly",

  "P-6GK41801196058811NK6QNTI":
    "standard-annual",

  "P-76Y177913D3206319NK6QV2A":
    "plus-data-annual",

  "P-68800109GT083772LNKYOFPA":
    "plus-data-monthly"

};




function getPlanInfo(planId) {

  return {

    planId:
      planId || "",

    planKey:
      PLAN_KEYS[planId] || "",

    planName:
      PLAN_NAMES[planId] || ""

  };

}



async function getPayPalAccessToken() {

  const clientId =
    PAYPAL_CLIENT_ID.value();

  const clientSecret =
    PAYPAL_CLIENT_SECRET.value();

  if (!clientId || !clientSecret) {

    throw new Error(
      "PayPal client credentials are missing."
    );

  }

  const credentials =
    Buffer
      .from(
        `${clientId}:${clientSecret}`
      )
      .toString("base64");

  const response =
    await fetch(
      `${PAYPAL_API}/v1/oauth2/token`,
      {
        method: "POST",

        headers: {
          "Authorization":
            `Basic ${credentials}`,

          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body:
          "grant_type=client_credentials"
      }
    );

  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `PayPal OAuth failed: ${response.status} ${text}`
    );

  }

  const data =
    await response.json();

  return data.access_token;

}


async function verifyPayPalWebhook(
  req,
  event
) {

  const transmissionId =
    req.headers[
      "paypal-transmission-id"
    ];

  const transmissionTime =
    req.headers[
      "paypal-transmission-time"
    ];

  const certUrl =
    req.headers[
      "paypal-cert-url"
    ];

  const authAlgo =
    req.headers[
      "paypal-auth-algo"
    ];

  const transmissionSig =
    req.headers[
      "paypal-transmission-sig"
    ];

  const webhookId =
    PAYPAL_WEBHOOK_ID.value();

  if (
    !transmissionId ||
    !transmissionTime ||
    !certUrl ||
    !authAlgo ||
    !transmissionSig ||
    !webhookId
  ) {

    logger.error(
      "Missing PayPal webhook verification information."
    );

    return false;

  }

  const accessToken =
    await getPayPalAccessToken();

  const verificationPayload = {

    transmission_id:
      transmissionId,

    transmission_time:
      transmissionTime,

    cert_url:
      certUrl,

    auth_algo:
      authAlgo,

    transmission_sig:
      transmissionSig,

    webhook_id:
      webhookId,

    webhook_event:
      event

  };

  const response =
    await fetch(
      `${PAYPAL_API}/v1/notifications/verify-webhook-signature`,
      {

        method: "POST",

        headers: {

          "Content-Type":
            "application/json",

          "Authorization":
            `Bearer ${accessToken}`

        },

        body:
          JSON.stringify(
            verificationPayload
          )

      }
    );

  if (!response.ok) {

    const text =
      await response.text();

    logger.error(
      "PayPal webhook verification failed.",
      {
        status:
          response.status,

        response:
          text
      }
    );

    return false;

  }

  const result =
    await response.json();

  logger.info(
    "PayPal webhook verification result.",
    {
      verificationStatus:
        result.verification_status
    }
  );

  return (
    result.verification_status ===
    "SUCCESS"
  );

}


async function getPayPalSubscription(
  subscriptionId
) {

  if (!subscriptionId) {

    throw new Error(
      "Subscription ID is required."
    );

  }

  const accessToken =
    await getPayPalAccessToken();

  const response =
    await fetch(
      `${PAYPAL_API}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {

        method: "GET",

        headers: {

          "Authorization":
            `Bearer ${accessToken}`,

          "Content-Type":
            "application/json"

        }

      }
    );

  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Unable to retrieve PayPal subscription: ${response.status} ${text}`
    );

  }

  return await response.json();

}



function getSubscriptionIdFromEvent(
  resource,
  eventType
) {

  if (
    !resource ||
    typeof resource !== "object"
  ) {
    return "";
  }

  // Sale events must use the subscription
  // reference, never the sale transaction ID.
  if (
    eventType === "PAYMENT.SALE.COMPLETED" ||
    eventType === "PAYMENT.SALE.REFUNDED" ||
    eventType === "PAYMENT.SALE.REVERSED"
  ) {

    return resource.billing_agreement_id || "";

  }

  // Subscription events may use resource.id.
  return (

    resource.billing_agreement_id ||

    resource.subscription_id ||

    resource.subscriptionId ||

    resource.id ||

    ""

  );

}


async function getMemberFromSubscription(
  subscriptionId
) {

  if (!subscriptionId) {

    return null;

  }

  const subscription =
    await getPayPalSubscription(
      subscriptionId
    );

  const customId =
    subscription.custom_id || "";

  if (!customId) {

    logger.warn(
      "PayPal subscription has no StudyFlix custom_id.",
      {
        subscriptionId
      }
    );

    return {

      subscription,

      customId:
        ""

    };

  }

  return {

    subscription,

    customId

  };

}


async function savePaymentRecord(
  customId,
  subscriptionId,
  resource,
  subscription
) {

  if (!customId) {

    throw new Error(
      "Cannot save payment without Firebase UID."
    );

  }

  const memberRef =
    db
      .collection("members")
      .doc(customId);

  /*
   * PayPal sale transaction ID.
   */

  const saleId =
    resource.id ||
    `payment_${Date.now()}`;

  const planId =
    subscription.plan_id ||
    "";

  const plan =
    getPlanInfo(planId);

  const amount =
    parseFloat(
      resource.amount?.total ||
      resource.amount?.value ||
      0
    );

  const currency =
    resource.amount?.currency ||
    resource.amount?.currency_code ||
    "USD";

  const paymentStatus =
    resource.state ||
    "COMPLETED";

  /*
   * Payment date.
   *
   * PayPal may provide create_time.
   */

  let paidAt = null;

  if (resource.create_time) {

    const parsedDate =
      new Date(
        resource.create_time
      );

    if (!Number.isNaN(
      parsedDate.getTime()
    )) {

      paidAt =
        admin.firestore.Timestamp
          .fromDate(parsedDate);

    }

  }

  /*
   * Save individual payment.
   */

  const paymentRef =
    memberRef
      .collection("payments")
      .doc(saleId);

  await paymentRef.set(
    {

      paypalSaleId:
        saleId,

      paypalSubscriptionId:
        subscriptionId,

      paypalPlanId:
        planId,

      paypalPlanKey:
        plan.planKey,

      planName:
        plan.planName,

      amount:
        amount,

      currency:
        currency,

      status:
        paymentStatus,

      paid:
        true,

      paidAt:
        paidAt ||

        admin.firestore.FieldValue
          .serverTimestamp(),

      createdAt:
        admin.firestore.FieldValue
          .serverTimestamp(),

      rawEventType:
        "PAYMENT.SALE.COMPLETED"

    },
    {
      merge: true
    }
  );

  /*
   * Update the main member document.
   */

  await memberRef.set(
    {

      paypalStatus:
  "ACTIVE",

paypalSubscriptionId:
  subscriptionId,

paypalPlanId:
  planId,

paypalPlanKey:
  plan.planKey,

membershipType:
  plan.planName,

plan:
  plan.planKey,

billingPeriod:
  plan.planKey.includes("annual")
    ? "annual"
    : "monthly",

membershipBillingPeriod:
  plan.planKey.includes("annual")
    ? "annual"
    : "monthly",

paid:
  true,

/*
 * AUTOMATIC STUDYFLIX APPROVAL
 *
 * PayPal has confirmed an actual
 * completed payment, so the learner
 * is automatically approved.
 */

applicationStatus:
  "approved",

status:
  "active",

approved:
  true,

approvedAt:
  paidAt ||
  admin.firestore.FieldValue
    .serverTimestamp(),

      /*
       * These fields are used by
       * the StudyFlix Admin Payments page.
       */

      paidAt:
        paidAt ||

        admin.firestore.FieldValue
          .serverTimestamp(),

      lastPaymentAt:
        paidAt ||

        admin.firestore.FieldValue
          .serverTimestamp(),

      lastPayment:
        {

          transactionId:
            saleId,

          amount:
            amount,

          currency:
            currency,

          method:
            "paypal",

          paid:
            true,

          paidAt:
            paidAt ||

            admin.firestore.FieldValue
              .serverTimestamp(),

          paypalSaleId:
            saleId,

          paypalSubscriptionId:
            subscriptionId,

          paypalPlanId:
            planId,

          paypalPlanKey:
            plan.planKey,

          paypalStatus:
            "COMPLETED"

        },

      paypalUpdatedAt:
        admin.firestore.FieldValue
          .serverTimestamp()

    },

    {
      merge:
        true
    }

  );

  logger.info(
    "StudyFlix PayPal payment recorded.",
    {

      customId,

      saleId,

      subscriptionId,

      planId,

      amount,

      currency

    }
  );

}


async function markPaymentFailed(
  customId,
  subscriptionId
) {

  if (!customId) {

    return;

  }

  await db
    .collection("members")
    .doc(customId)
    .set(
      {

        paypalStatus:
          "PAYMENT_FAILED",

        paid:
          false,

        paypalSubscriptionId:
          subscriptionId || "",

        paypalUpdatedAt:
          admin.firestore.FieldValue
            .serverTimestamp()

      },
      {
        merge:
          true
      }
    );

  logger.warn(
    "StudyFlix PayPal payment failed.",
    {

      customId,

      subscriptionId

    }
  );

}


async function updateSubscriptionStatus(
  customId,
  subscriptionId,
  fields
) {

  if (!customId) {

    return;

  }

  await db
    .collection("members")
    .doc(customId)
    .set(
      {

        paypalSubscriptionId:
          subscriptionId || "",

        paypalUpdatedAt:
          admin.firestore.FieldValue
            .serverTimestamp(),

        ...fields

      },
      {
        merge:
          true
      }
    );

}

exports.paypalWebhook =
  onRequest(

    {

      secrets: [

        PAYPAL_CLIENT_ID,

        PAYPAL_CLIENT_SECRET,

        PAYPAL_WEBHOOK_ID

      ],

      cors:
        false,

      maxInstances:
        5

    },

    async (req, res) => {

      /*
       * Only POST is allowed.
       */

      if (req.method !== "POST") {

        return res
          .status(405)
          .send("Method Not Allowed");

      }

      try {

        const event =
          req.body || {};

        const eventId =
          event.id || "";

        const eventType =
          event.event_type || "";

        const resource =
          event.resource || {};

        logger.info(
          "PayPal webhook received.",
          {

            eventId,

            eventType

          }
        );

        const verified =
          await verifyPayPalWebhook(
            req,
            event
          );

        if (!verified) {

          logger.error(
            "Rejected unverified PayPal webhook.",
            {

              eventId,

              eventType

            }
          );

          return res
            .status(400)
            .send(
              "Invalid PayPal webhook"
            );

        }

        if (!eventId || !eventType) {

          return res
            .status(400)
            .send(
              "Invalid webhook"
            );

        }

        const eventRef =
          db
            .collection(
              "paypalWebhookEvents"
            )
            .doc(eventId);

        const existingEvent =
          await eventRef.get();

        if (existingEvent.exists) {

          logger.info(
            "Duplicate PayPal webhook ignored.",
            {
              eventId
            }
          );

          return res
            .status(200)
            .send("OK");

        }

        if (
          eventType ===
          "BILLING.SUBSCRIPTION.ACTIVATED"
        ) {

          const subscriptionId =
            resource.id || "";

          const planId =
            resource.plan_id || "";

          const customId =
            resource.custom_id || "";

          const plan =
            getPlanInfo(planId);

          if (
            !subscriptionId ||
            !customId
          ) {

            logger.warn(
              "Activated subscription missing ID or custom_id.",
              {

                subscriptionId,

                customId

              }
            );

          }

          else if (!plan.planKey) {

            logger.warn(
              "Unknown StudyFlix PayPal plan.",
              {

                planId,

                customId

              }
            );

          }

          else {

            /*
             * IMPORTANT:
             *
             * We DO NOT approve the application here.
             *
             * Payment/subscription approval and
             * StudyFlix admin application approval
             * remain separate.
             */

            await updateSubscriptionStatus(
              customId,
              subscriptionId,
              {

                paypalStatus:
                  "ACTIVE",

                paypalPlanId:
                  planId,

                paypalPlanKey:
                  plan.planKey,

                membershipType:
                  plan.planName,

                plan:
                  plan.planKey,

                /*
                 * Subscription exists,
                 * but the admin still needs
                 * to approve the application.
                 */
              }
            );

            logger.info(
              "StudyFlix PayPal subscription activated.",
              {

                customId,

                subscriptionId,

                planId

              }
            );

          }

        }

        /* =================================================
           PAYMENT COMPLETED
        ================================================= */

       
else if (
  eventType ===
  "PAYMENT.SALE.COMPLETED"
) {

  const subscriptionId =
    getSubscriptionIdFromEvent(
      resource,
      eventType
    );

  if (!subscriptionId) {

    throw new Error(
      "Completed PayPal payment has no subscription ID. Event: " +
      eventId
    );

  }

  const memberData =
    await getMemberFromSubscription(
      subscriptionId
    );

  const customId =
    memberData?.customId || "";

  const subscription =
    memberData?.subscription || {};

  if (!customId) {

    throw new Error(
      "Could not identify StudyFlix member from PayPal subscription. Subscription: " +
      subscriptionId +
      ", Event: " +
      eventId
    );

  }

  await savePaymentRecord(
    customId,
    subscriptionId,
    resource,
    subscription
  );

}



        else if (
          eventType ===
          "BILLING.SUBSCRIPTION.UPDATED"
        ) {

          const subscriptionId =
            resource.id || "";

          const customId =
            resource.custom_id || "";

          const planId =
            resource.plan_id || "";

          const plan =
            getPlanInfo(planId);

          if (customId) {

            await updateSubscriptionStatus(
              customId,

              subscriptionId,

              {

                paypalStatus:
                  resource.status ||
                  "ACTIVE",

                paypalPlanId:
                  planId,

                paypalPlanKey:
                  plan.planKey ||
                  "",

                membershipType:
                  plan.planName ||
                  "",

                plan:
                  plan.planKey ||
                  ""

              }
            );

          }

          logger.info(
            "PayPal subscription updated.",
            {

              customId,

              subscriptionId,

              planId

            }
          );

        }

        else if (
          eventType ===
          "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
        ) {

          const subscriptionId =
            getSubscriptionIdFromEvent(
              resource,
              eventType
            );

          let customId =
            resource.custom_id || "";

          /*
           * PayPal may not provide custom_id
           * directly in the failed-payment event.
           *
           * Retrieve the subscription to find it.
           */

          if (
            !customId &&
            subscriptionId
          ) {

            try {

              const memberData =
                await getMemberFromSubscription(
                  subscriptionId
                );

              customId =
                memberData?.customId || "";

            }

            catch (error) {

              logger.error(
                "Unable to retrieve subscription after payment failure.",
                {

                  subscriptionId,

                  error:
                    error.message

                }
              );

            }

          }

          await markPaymentFailed(
            customId,

            subscriptionId

          );

        }

        else if (
          eventType ===
          "BILLING.SUBSCRIPTION.CANCELLED"
        ) {

          const subscriptionId =
            resource.id || "";

          let customId =
            resource.custom_id || "";

          if (
            !customId &&
            subscriptionId
          ) {

            const memberData =
              await getMemberFromSubscription(
                subscriptionId
              );

            customId =
              memberData?.customId || "";

          }

          await updateSubscriptionStatus(
            customId,

            subscriptionId,

            {

              paypalStatus:
                "CANCELLED",

              status:
                "inactive",

              paid:
                false

            }

          );

          logger.info(
            "StudyFlix PayPal subscription cancelled.",
            {

              customId,

              subscriptionId

            }
          );

        }

        else if (
          eventType ===
          "BILLING.SUBSCRIPTION.SUSPENDED"
        ) {

          const subscriptionId =
            resource.id || "";

          let customId =
            resource.custom_id || "";

          if (
            !customId &&
            subscriptionId
          ) {

            const memberData =
              await getMemberFromSubscription(
                subscriptionId
              );

            customId =
              memberData?.customId || "";

          }

          await updateSubscriptionStatus(
            customId,

            subscriptionId,

            {

              paypalStatus:
                "SUSPENDED",

              status:
                "inactive",

              paid:
                false

            }

          );

          logger.warn(
            "StudyFlix PayPal subscription suspended.",
            {

              customId,

              subscriptionId

            }
          );

        }


        else if (
          eventType ===
          "BILLING.SUBSCRIPTION.EXPIRED"
        ) {

          const subscriptionId =
            resource.id || "";

          let customId =
            resource.custom_id || "";

          if (
            !customId &&
            subscriptionId
          ) {

            const memberData =
              await getMemberFromSubscription(
                subscriptionId
              );

            customId =
              memberData?.customId || "";

          }

          await updateSubscriptionStatus(
            customId,

            subscriptionId,

            {

              paypalStatus:
                "EXPIRED",

              status:
                "inactive",

              paid:
                false,

              applicationStatus:
                "expired"

            }

          );

          logger.info(
            "StudyFlix PayPal subscription expired.",
            {

              customId,

              subscriptionId

            }
          );

        }

        else if (
          eventType ===
          "PAYMENT.SALE.REFUNDED"
        ) {

          const subscriptionId =
             getSubscriptionIdFromEvent(
             resource,
             eventType
           );

          let customId =
            resource.custom_id || "";

          if (
            !customId &&
            subscriptionId
          ) {

            try {

              const memberData =
                await getMemberFromSubscription(
                  subscriptionId
                );

              customId =
                memberData?.customId || "";

            }

            catch (error) {

              logger.warn(
                "Could not identify member for refunded payment.",
                {

                  subscriptionId,

                  error:
                    error.message

                }
              );

            }

          }

          if (customId) {

            await updateSubscriptionStatus(
              customId,

              subscriptionId,

              {

                paypalStatus:
                  "REFUNDED",

                paid:
                  false

              }

            );

          }

          logger.warn(
            "PayPal payment refunded.",
            {

              customId,

              subscriptionId,

              eventId

            }
          );

        }


        else if (
          eventType ===
          "PAYMENT.SALE.REVERSED"
        ) {

          const subscriptionId =
            getSubscriptionIdFromEvent(
              resource,
              eventType
            );

          let customId =
            resource.custom_id || "";

          if (
            !customId &&
            subscriptionId
          ) {

            try {

              const memberData =
                await getMemberFromSubscription(
                  subscriptionId
                );

              customId =
                memberData?.customId || "";

            }

            catch (error) {

              logger.warn(
                "Could not identify member for reversed payment.",
                {

                  subscriptionId,

                  error:
                    error.message

                }
              );

            }

          }

          if (customId) {

            await updateSubscriptionStatus(
              customId,

              subscriptionId,

              {

                paypalStatus:
                  "REVERSED",

                paid:
                  false

              }

            );

          }

          logger.warn(
            "PayPal payment reversed.",
            {

              customId,

              subscriptionId,

              eventId

            }
          );

        }

        else {

          logger.info(
            "Unhandled PayPal event.",
            {

              eventId,

              eventType

            }
          );

        }

        await eventRef.set({

          eventType:

            eventType,

          processedAt:

            admin.firestore.FieldValue
              .serverTimestamp()

        });

        return res
          .status(200)
          .send("OK");

      }

      catch (error) {

        logger.error(
          "StudyFlix PayPal webhook error.",
          {

            message:
              error.message,

            stack:
              error.stack

          }
        );

        /*
         * 500 tells PayPal that processing failed.
         * PayPal can retry the delivery.
         */

        return res
          .status(500)
          .send(
            "Webhook processing error"
          );

      }

    }

  );