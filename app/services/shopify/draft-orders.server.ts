import { authenticate } from "../../shopify.server";

export type DraftOrderInput = {
  customerId?: string | null;
  note?: string | null;
  items: Array<{
    variantId: string;
    quantity: number;
    originalUnitPrice?: string;
    customAttributes?: Array<{
      key: string;
      value: string;
    }>;
  }>;
};

export async function createDraftOrder(request: Request, input: DraftOrderInput) {
  const { admin } = await authenticate.admin(request);

  const lineItems = input.items.map((item) => ({
    quantity: Math.max(1, Number(item.quantity) || 1),
    variantId: item.variantId,
    ...(item.originalUnitPrice
      ? { originalUnitPrice: item.originalUnitPrice }
      : {}),
    ...(item.customAttributes && item.customAttributes.length > 0
      ? { customAttributes: item.customAttributes }
      : {}),
  }));

  const response = await admin.graphql(
    `#graphql
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(draftOrder: $input) {
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
          note: input.note || "",
          lineItems,
        },
      },
    },
  );

  const payload = await response.json();
  const data = payload?.data?.draftOrderCreate ?? { draftOrder: null, userErrors: [] };

  return data;
}
