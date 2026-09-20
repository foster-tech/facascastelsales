import { authenticate } from "../../shopify.server";

export type DraftOrderInput = {
  customerId?: string | null;
  note?: string | null;
  customAttributes?: Array<{
    key: string;
    value: string;
  }>;
  items: Array<{
    variantId: string;
    quantity: number;
    priceOverride?: string;
    customAttributes?: Array<{
      key: string;
      value: string;
    }>;
  }>;
};

export async function createDraftOrder(request: Request, input: DraftOrderInput) {
  const { admin, session } = await authenticate.admin(request);

  const shopResponse = await admin.graphql(
    `#graphql
      query ShopCurrency {
        shop {
          currencyCode
        }
      }`,
  );
  const shopPayload = (await shopResponse.json()) as {
    data?: { shop?: { currencyCode?: string } };
  };
  const currencyCode = shopPayload.data?.shop?.currencyCode || "BRL";
  const sellerId = session?.onlineAccessInfo?.associated_user?.id
    ? String(session.onlineAccessInfo.associated_user.id)
    : "não identificado";
  const sellerAttribute = { key: "Vendedor ID", value: sellerId };
  const note = [input.note?.trim(), `Vendedor ID: ${sellerId}`]
    .filter(Boolean)
    .join("\n");

  const lineItems = input.items.map((item) => ({
    quantity: Math.max(1, Number(item.quantity) || 1),
    variantId: item.variantId,
    ...(item.priceOverride
      ? {
          priceOverride: {
            amount: item.priceOverride,
            currencyCode,
          },
        }
      : {}),
    ...(item.customAttributes && item.customAttributes.length > 0
      ? { customAttributes: item.customAttributes }
      : {}),
  }));

  const response = await admin.graphql(
    `#graphql
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            invoiceUrl
            totalPrice
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        input: {
          customerId: input.customerId || null,
          note,
          customAttributes: [
            ...(input.customAttributes || []),
            sellerAttribute,
          ],
          lineItems,
        },
      },
    },
  );

  const payload = (await response.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string; name: string; invoiceUrl: string; totalPrice: string };
        userErrors?: Array<{ message?: string }>;
      };
    };
    errors?: Array<{ message?: string }>;
  };
  if (payload?.errors?.length) {
    return {
      draftOrder: null,
      userErrors: payload.errors.map((error: { message?: string }) => ({
        message: error.message || "Erro GraphQL ao criar o pedido.",
      })),
    };
  }

  const data = payload?.data?.draftOrderCreate ?? { draftOrder: null, userErrors: [] };

  return data;
}
