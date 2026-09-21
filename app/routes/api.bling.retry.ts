import type { ActionFunctionArgs } from "react-router";
import { processBlingOrderSync } from "../services/bling.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const expectedSecret = process.env.BLING_RETRY_SECRET;
  const receivedSecret = request.headers.get("x-bling-retry-secret");

  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const pendingSyncs = await db.blingOrderSync.findMany({
    where: { status: "PENDING" },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });

  for (const sync of pendingSyncs) {
    try {
      await processBlingOrderSync(sync);
    } catch (error) {
      console.error(`[bling] Retry failed for ${sync.shopifyOrderName}`, error);
      await db.blingOrderSync.update({
        where: { id: sync.id },
        data: {
          status: "FAILED",
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return Response.json({ processed: pendingSyncs.length });
};
