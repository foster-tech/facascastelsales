import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeSellerName } from "../services/sellers.server";
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

async function setOrderSellerMetafield(
  admin: NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>,
  orderGid: string,
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
    throw new Error(`Não foi possível gravar custom.vendedor: ${errors.join("; ")}`);
  }
}

async function getOrderSellerMetafield(
  admin: NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>,
  orderGid: string,
) {
  const response = await admin.graphql(
    `#graphql
      query OrderSellerMetafield($id: ID!) {
        order(id: $id) {
          metafield(namespace: "custom", key: "vendedor") {
            value
          }
        }
      }`,
    { variables: { id: orderGid } },
  );
  const payload = (await response.json()) as {
    data?: { order?: { metafield?: { value?: string } | null } | null };
  };

  return payload.data?.order?.metafield?.value?.trim() || null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop, webhookId, session } = await authenticate.webhook(request);

  if (!session || !admin) {
    console.log(`[orders/paid] Sessão offline indisponível para ${shop}`);
    return new Response();
  }

  const shopifyOrderId = String(payload.id);
  const shopifyOrderName = String(payload.name || `#${payload.id}`);
  const orderGid = getOrderGid(payload);
  const attributes = payload.note_attributes || payload.custom_attributes;
  const sellerId = getAttribute(attributes, "_seller_id");
  const sellerAttributeName = getAttribute(attributes, "vendedor");
  const metafieldSellerName = sellerAttributeName
    ? null
    : await getOrderSellerMetafield(admin, orderGid);
  let seller = sellerId
    ? await db.seller.findFirst({ where: { id: sellerId, active: true }, select: { id: true, name: true } })
    : null;
  if (!seller && (sellerAttributeName || metafieldSellerName)) {
    seller = await db.seller.findFirst({
      where: {
        normalizedName: normalizeSellerName(sellerAttributeName || metafieldSellerName || ""),
        active: true,
      },
      select: { id: true, name: true },
    });
  }
    const sellerName = seller?.name || sellerAttributeName || metafieldSellerName;

  console.log(`[orders/paid] Shopify order ${shopifyOrderName}`);

  if (!sellerName) {
    console.log("Pedido Shopify sem vendedor associado.");
    return new Response();
  }

  console.log(`[orders/paid] Seller: ${sellerName}`);
  const sync = await db.blingOrderSync.upsert({
    where: { shopDomain_shopifyOrderId: { shopDomain: shop, shopifyOrderId } },
    create: {
      shopDomain: shop,
      shopifyOrderId,
      shopifyOrderName,
      sellerId: seller?.id || null,
      sellerName,
      webhookId,
      status: "PENDING",
    },
    update: {
      shopifyOrderName,
      sellerId: seller?.id || null,
      sellerName,
      webhookId,
    },
  });

  try {
    await setOrderSellerMetafield(admin, orderGid, sellerName);
    if (sync.status !== "SYNCED") {
      await processBlingOrderSync(sync);
    }
  } catch (error) {
    console.error(`[orders/paid] Falha ao sincronizar ${shopifyOrderName}`, error);
    if (error instanceof BlingRateLimitError) {
      await db.blingOrderSync.update({
        where: { id: sync.id },
        data: {
          status: "PENDING",
          attempts: { increment: 1 },
          lastError: error.message,
        },
      });
    } else {
      await markBlingOrderSyncFailed(sync.id, error);
    }
  }

  return new Response();
};
