import type { ActionFunctionArgs } from "react-router";
import { processBlingOrderSync } from "../services/bling.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const expectedSecret = process.env.BLING_RETRY_SECRET;
  const receivedSecret = request.headers.get("x-bling-retry-secret");

  if (!expectedSecret || receivedSecret !== expectedSecret) {
    console.warn("[bling/retry] Unauthorized request", {
      secretConfigured: Boolean(expectedSecret),
      secretReceived: Boolean(receivedSecret),
    });
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("[bling/retry] Authorized retry started");

  const pendingSyncs = await db.blingOrderSync.findMany({
    where: { status: "PENDING" },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });

  console.log("[bling/retry] Pending synchronizations loaded", {
    count: pendingSyncs.length,
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
      }, error);
      const failedSync = await db.blingOrderSync.update({
        where: { id: sync.id },
        data: {
          status: "FAILED",
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      console.error("[bling/retry] Synchronization marked as failed", {
        syncId: failedSync.id,
        status: failedSync.status,
        attempts: failedSync.attempts,
        lastError: failedSync.lastError,
      });
    }
  }

  console.log("[bling/retry] Retry completed", { processed: pendingSyncs.length });
  return Response.json({ processed: pendingSyncs.length });
};
