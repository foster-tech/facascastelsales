import { waitUntil } from "@vercel/functions";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  BlingRateLimitError,
  markBlingOrderSyncFailed,
  processBlingOrderSync,
} from "../services/bling.server";
import {
  parseBlingOrderCreatedWebhook,
  parseBlingWebhookEnvelope,
  persistBlingWebhookEvent,
  processBlingWebhookEvent,
  processBlingWebhookEventBatch,
  verifyBlingWebhookSignature,
} from "../services/bling-webhook.server";
import db from "../db.server";

const processingLeaseMs = 5 * 60 * 1000;

async function runRetryBatch() {
  console.log("[bling/retry] Authorized retry started");

  const eventBatch = await processBlingWebhookEventBatch(20);
  const staleBefore = new Date(Date.now() - processingLeaseMs);
  const pendingSyncs = await db.blingOrderSync.findMany({
    where: {
      AND: [
        {
          OR: [
            { status: { in: ["PENDING", "FAILED"] } },
            { status: "PROCESSING", updatedAt: { lt: staleBefore } },
          ],
        },
        {
          webhookEvents: {
            none: { status: { in: ["PENDING", "FAILED", "PROCESSING"] } },
          },
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });

  console.log("[bling/retry] Pending synchronizations loaded", {
    count: pendingSyncs.length,
    eventCount: eventBatch.loaded,
    syncs: pendingSyncs.map((sync) => ({
      syncId: sync.id,
      shopifyOrderName: sync.shopifyOrderName,
      attempts: sync.attempts,
    })),
  });

  for (const sync of pendingSyncs) {
    try {
      console.log("[bling/retry] Processing synchronization", {
        syncId: sync.id,
        shopifyOrderName: sync.shopifyOrderName,
        attempts: sync.attempts,
      });
      const processedSync = await processBlingOrderSync(sync);
      console.log("[bling/retry] Synchronization processed", {
        syncId: processedSync.id,
        status: processedSync.status,
        attempts: processedSync.attempts,
        lastError: processedSync.lastError,
      });
    } catch (error) {
      console.error("[bling/retry] Synchronization failed", {
        syncId: sync.id,
        shopifyOrderName: sync.shopifyOrderName,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (!(error instanceof BlingRateLimitError)) {
        await markBlingOrderSyncFailed(sync.id, error);
      }
    }
  }

  console.log("[bling/retry] Retry completed", {
    processed: pendingSyncs.length,
    eventsProcessed: eventBatch.loaded,
    eventsSynchronized: eventBatch.synchronized,
  });
  return Response.json({
    processed: pendingSyncs.length,
    eventsProcessed: eventBatch.loaded,
    eventsSynchronized: eventBatch.synchronized,
  });
}

async function handleManualRetry(request: Request) {
  const expectedSecret = process.env.BLING_RETRY_SECRET;
  const receivedSecret = request.headers.get("x-bling-retry-secret");

  if (!expectedSecret || receivedSecret !== expectedSecret) {
    console.warn("[bling/retry] Unauthorized request", {
      secretConfigured: Boolean(expectedSecret),
      secretReceived: Boolean(receivedSecret),
    });
    return new Response("Unauthorized", { status: 401 });
  }

  return runRetryBatch();
}

async function handleBlingWebhook(request: Request) {
  const rawBodyBuffer = Buffer.from(await request.arrayBuffer());
  const rawBody = rawBodyBuffer.toString("utf8");
  const signature = request.headers.get("x-bling-signature-256");
  const clientSecret = process.env.BLING_CLIENT_SECRET;

  if (!verifyBlingWebhookSignature(rawBodyBuffer, signature, clientSecret)) {
    console.warn("[bling/webhook] Rejected request with invalid signature", {
      signatureReceived: Boolean(signature),
      secretConfigured: Boolean(clientSecret),
    });
    return new Response("Unauthorized", { status: 401 });
  }

  let envelope;
  try {
    envelope = parseBlingWebhookEnvelope(rawBody);
  } catch (error) {
    console.warn("[bling/webhook] Invalid payload", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return new Response("Invalid webhook payload", { status: 400 });
  }

  if (envelope.event !== "order.created" || envelope.version !== "v1") {
    console.log("[bling/webhook] Unsupported event ignored", {
      eventId: envelope.eventId,
      event: envelope.event,
      version: envelope.version,
      companyId: envelope.companyId,
    });
    return new Response(null, { status: 204 });
  }

  let payload;
  try {
    payload = parseBlingOrderCreatedWebhook(envelope);
  } catch (error) {
    console.warn("[bling/webhook] Invalid order.created payload", {
      eventId: envelope.eventId,
      companyId: envelope.companyId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return new Response("Invalid webhook payload", { status: 400 });
  }

  const persisted = await persistBlingWebhookEvent(payload);
  console.log("[bling/webhook] order.created received", {
    eventId: payload.eventId,
    companyId: payload.companyId,
    shopifyOrderId: payload.data.numeroLoja,
    blingOrderId: payload.data.id,
    duplicate: !persisted.created,
  });

  waitUntil(
    processBlingWebhookEvent(payload.eventId).catch((error) => {
      console.error("[bling/webhook] Background processing failed", {
        eventId: payload.eventId,
        shopifyOrderId: payload.data.numeroLoja,
        blingOrderId: payload.data.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }),
  );

  return Response.json(
    { received: true, duplicate: !persisted.created },
    { status: 202 },
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.has("x-bling-retry-secret")) {
    return handleManualRetry(request);
  }

  return handleBlingWebhook(request);
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const expectedSecret = process.env.CRON_SECRET;
  const receivedAuthorization = request.headers.get("authorization");
  if (!expectedSecret || receivedAuthorization !== `Bearer ${expectedSecret}`) {
    console.warn("[bling/retry] Unauthorized cron request", {
      secretConfigured: Boolean(expectedSecret),
      authorizationReceived: Boolean(receivedAuthorization),
    });
    return new Response("Unauthorized", { status: 401 });
  }

  return runRetryBatch();
};
