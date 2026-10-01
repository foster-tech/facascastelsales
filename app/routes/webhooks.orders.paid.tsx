import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  BlingRateLimitError,
  markBlingOrderSyncFailed,
  processBlingOrderSync,
} from "../services/bling.server";

const getAttribute = (attributes: unknown, key: string) => {
  if (!Array.isArray(attributes)) {
    return null;
  }

  const attribute = attributes.find((item) => {
    const candidate = item as { key?: string; name?: string; value?: string };
    return candidate.key === key || candidate.name === key;
  }) as { value?: string } | undefined;

  return attribute?.value?.trim() || null;
};

const getOrderGid = (payload: Record<string, any>) => {
  const externalId = payload.admin_graphql_api_id || payload.admin_graphql_api_order_id;
  if (externalId) {
    return String(externalId);
  }

  return `gid://shopify/Order/${payload.id}`;
};

async function setOrderBlingMetafields(
  admin: NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>,
  orderGid: string,
  sellerId: string,
  sellerName: string,
) {
  const response = await admin.graphql(
    `#graphql
      mutation SetOrderSellerMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key value }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: orderGid,
            namespace: "custom",
            key: "vendedor",
            type: "single_line_text_field",
            value: sellerName,
          },
          {
            ownerId: orderGid,
            namespace: "custom",
            key: "vendedor_bling_id",
            type: "single_line_text_field",
            value: sellerId,
          },
        ],
      },
    },
  );
  const payload = (await response.json()) as {
    data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } };
    errors?: Array<{ message?: string }>;
  };
  const errors = [
    ...(payload.errors || []).map((error) => error.message || "Erro GraphQL"),
    ...(payload.data?.metafieldsSet?.userErrors || []).map((error) => error.message),
  ];

  if (errors.length > 0) {
    throw new Error(`Não foi possível gravar os metacampos do vendedor: ${errors.join("; ")}`);
  }
}

async function getOrderSellerMetafields(
  admin: NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>,
  orderGid: string,
) {
  const response = await admin.graphql(
    `#graphql
      query OrderSellerMetafield($id: ID!) {
        order(id: $id) {
          sellerName: metafield(namespace: "custom", key: "vendedor") {
            value
          }
          sellerId: metafield(namespace: "custom", key: "vendedor_bling_id") {
            value
          }
        }
      }`,
    { variables: { id: orderGid } },
  );
  const payload = (await response.json()) as {
    data?: {
      order?: {
        sellerName?: { value?: string } | null;
        sellerId?: { value?: string } | null;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    console.warn("[orders/paid] Seller metafield query returned errors", {
      orderGid,
      errors: payload.errors.map((error) => error.message || "Erro GraphQL"),
    });
  }

  return {
    sellerName: payload.data?.order?.sellerName?.value?.trim() || null,
    sellerId: payload.data?.order?.sellerId?.value?.trim() || null,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop, webhookId, session } = await authenticate
    .webhook(request)
    .catch((error) => {
      console.error(
        "[orders/paid] Webhook authentication failed",
        {
          pathname: new URL(request.url).pathname,
        },
        error,
      );
      throw error;
    });

  console.log("[orders/paid] Webhook authenticated", {
    shop,
    webhookId,
    orderId: payload?.id ? String(payload.id) : null,
    orderName: payload?.name ? String(payload.name) : null,
    financialStatus: payload?.financial_status || null,
    hasSession: Boolean(session),
    hasAdmin: Boolean(admin),
  });

  if (!session || !admin) {
    console.warn("[orders/paid] Processing stopped: offline session unavailable", {
      shop,
      webhookId,
      hasSession: Boolean(session),
      hasAdmin: Boolean(admin),
    });
    return new Response();
  }

  const shopifyOrderId = String(payload.id);
  const shopifyOrderName = String(payload.name || `#${payload.id}`);
  const orderGid = getOrderGid(payload);
  const attributes = payload.note_attributes || payload.custom_attributes;
  const sellerIdAttribute =
    getAttribute(attributes, "_bling_seller_id") || getAttribute(attributes, "_seller_id");
  const sellerAttributeName = getAttribute(attributes, "vendedor");
  const blingContactIdAttribute = getAttribute(attributes, "_bling_contact_id");
  const blingContactName = getAttribute(attributes, "cliente_bling");

  console.log("[orders/paid] Resolving seller", {
    shop,
    webhookId,
    shopifyOrderId,
    shopifyOrderName,
    attributeKeys: Array.isArray(attributes)
      ? attributes
          .map((item) => {
            const candidate = item as { key?: string; name?: string };
            return candidate.key || candidate.name || null;
          })
          .filter(Boolean)
      : [],
    hasSellerIdAttribute: Boolean(sellerIdAttribute),
    hasSellerNameAttribute: Boolean(sellerAttributeName),
    hasBlingContactIdAttribute: Boolean(blingContactIdAttribute),
  });

  let sellerMetafields = {
    sellerId: null as string | null,
    sellerName: null as string | null,
  };
  try {
    if (!sellerIdAttribute || !sellerAttributeName) {
      sellerMetafields = await getOrderSellerMetafields(admin, orderGid);
    }
  } catch (error) {
    console.error(
      "[orders/paid] Seller resolution failed",
      {
        shop,
        webhookId,
        shopifyOrderId,
        shopifyOrderName,
        orderGid,
      },
      error,
    );
    throw error;
  }
  const sellerIdCandidate = sellerIdAttribute || sellerMetafields.sellerId;
  const sellerId = sellerIdCandidate && /^\d+$/.test(sellerIdCandidate) ? sellerIdCandidate : null;
  const sellerName = sellerAttributeName || sellerMetafields.sellerName;
  const blingContactId =
    blingContactIdAttribute && /^\d+$/.test(blingContactIdAttribute)
      ? blingContactIdAttribute
      : null;

  console.log("[orders/paid] Seller resolution completed", {
    shopifyOrderId,
    shopifyOrderName,
    hasBlingSellerId: Boolean(sellerId),
    sellerFromAttribute: Boolean(sellerAttributeName),
    sellerFromMetafield: Boolean(sellerMetafields.sellerName),
    hasSellerName: Boolean(sellerName),
  });

  if (!sellerName) {
    console.warn("[orders/paid] Processing stopped: order has no associated seller", {
      shop,
      webhookId,
      shopifyOrderId,
      shopifyOrderName,
    });
    return new Response();
  }

  console.log("[orders/paid] Upserting BlingOrderSync", {
    shop,
    webhookId,
    shopifyOrderId,
    shopifyOrderName,
    sellerId,
    sellerName,
    blingContactId,
  });

  let sync;
  try {
    sync = await db.blingOrderSync.upsert({
      where: {
        shopDomain_shopifyOrderId: { shopDomain: shop, shopifyOrderId },
      },
      create: {
        shopDomain: shop,
        shopifyOrderId,
        shopifyOrderName,
        sellerId,
        sellerName,
        blingContactId,
        blingContactName,
        webhookId,
        status: "PENDING",
      },
      update: {
        shopifyOrderName,
        sellerId,
        sellerName,
        blingContactId,
        blingContactName,
        webhookId,
      },
    });
  } catch (error) {
    console.error(
      "[orders/paid] BlingOrderSync upsert failed",
      {
        shop,
        webhookId,
        shopifyOrderId,
        shopifyOrderName,
      },
      error,
    );
    throw error;
  }

  console.log("[orders/paid] BlingOrderSync persisted", {
    syncId: sync.id,
    status: sync.status,
    attempts: sync.attempts,
    shopifyOrderId,
    shopifyOrderName,
  });

  try {
    console.log("[orders/paid] Writing seller metafields", {
      syncId: sync.id,
      orderGid,
    });
    if (sellerId) {
      await setOrderBlingMetafields(admin, orderGid, sellerId, sellerName);
    }

    if (sync.status !== "SYNCED") {
      console.log("[orders/paid] Starting Bling synchronization", {
        syncId: sync.id,
        status: sync.status,
      });
      const processedSync = await processBlingOrderSync(sync);
      console.log("[orders/paid] Bling synchronization finished", {
        syncId: processedSync.id,
        status: processedSync.status,
        attempts: processedSync.attempts,
        hasBlingOrderId: Boolean(processedSync.blingOrderId),
        lastError: processedSync.lastError,
      });
    } else {
      console.log("[orders/paid] Bling synchronization skipped: already synchronized", {
        syncId: sync.id,
      });
    }
  } catch (error) {
    console.error(
      "[orders/paid] Synchronization failed",
      {
        syncId: sync.id,
        shopifyOrderId,
        shopifyOrderName,
      },
      error,
    );
    if (error instanceof BlingRateLimitError) {
      const pendingSync = await db.blingOrderSync.update({
        where: { id: sync.id },
        data: {
          status: "PENDING",
          attempts: { increment: 1 },
          lastError: error.message,
        },
      });
      console.warn("[orders/paid] Synchronization kept pending after rate limit", {
        syncId: pendingSync.id,
        status: pendingSync.status,
        attempts: pendingSync.attempts,
      });
    } else {
      const failedSync = await markBlingOrderSyncFailed(sync.id, error);
      console.error("[orders/paid] Synchronization marked as failed", {
        syncId: failedSync.id,
        status: failedSync.status,
        attempts: failedSync.attempts,
        lastError: failedSync.lastError,
      });
    }
  }

  console.log("[orders/paid] Webhook processing completed", {
    webhookId,
    shopifyOrderId,
    shopifyOrderName,
    syncId: sync.id,
  });
  return new Response();
};
