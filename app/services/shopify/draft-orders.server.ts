import { authenticate } from "../../shopify.server";
import type { BlingContactAddress, BlingContactResult } from "../bling.server";

export type DraftOrderInput = {
  customer?: BlingContactResult | null;
  note?: string | null;
  sellerId: string;
  sellerName: string;
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

const splitContactName = (name: string) => {
  const [firstName, ...lastNameParts] = name.trim().split(/\s+/);
  return {
    firstName: firstName || name,
    lastName: lastNameParts.join(" ") || undefined,
  };
};

const normalizePhone = (phone?: string | null) => {
  if (!phone) {
    return undefined;
  }

  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    return `+${digits}`;
  }
  if (phone.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }

  return undefined;
};

const mapBlingAddress = (customer: BlingContactResult, address?: BlingContactAddress | null) => {
  if (!address) {
    return null;
  }

  const hasPostalAddress = Boolean(
    address.street || address.city || address.provinceCode || address.zip,
  );
  if (!hasPostalAddress) {
    return null;
  }

  const { firstName, lastName } = splitContactName(customer.name);
  const countryName = customer.countryName
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const countryCode =
    customer.personType !== "E" || countryName === "brasil" || countryName === "brazil"
      ? "BR"
      : undefined;

  return {
    firstName,
    lastName,
    ...(customer.personType === "J" ? { company: customer.name } : {}),
    address1: [address.street, address.number].filter(Boolean).join(", ") || undefined,
    address2: [address.complement, address.neighborhood].filter(Boolean).join(" - ") || undefined,
    city: address.city,
    provinceCode: address.provinceCode,
    zip: address.zip,
    countryCode,
    phone: normalizePhone(customer.phone),
  };
};

export async function createDraftOrder(request: Request, input: DraftOrderInput) {
  const { admin } = await authenticate.admin(request);

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
  const note = [
    input.note?.trim(),
    `Vendedor Bling: ${input.sellerName}`,
    input.customer ? `Cliente Bling: ${input.customer.name}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const shippingAddress = input.customer
    ? mapBlingAddress(input.customer, input.customer.generalAddress)
    : null;
  const billingAddress = input.customer
    ? mapBlingAddress(
        input.customer,
        input.customer.billingAddress || input.customer.generalAddress,
      )
    : null;
  const customerPhone = normalizePhone(input.customer?.phone);

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
          ...(input.customer?.email ? { email: input.customer.email } : {}),
          ...(customerPhone ? { phone: customerPhone } : {}),
          ...(shippingAddress ? { shippingAddress } : {}),
          ...(billingAddress ? { billingAddress } : {}),
          note,
          customAttributes: [
            { key: "vendedor", value: input.sellerName },
            { key: "_bling_seller_id", value: input.sellerId },
            ...(input.customer
              ? [
                  { key: "cliente_bling", value: input.customer.name },
                  { key: "_bling_contact_id", value: input.customer.id },
                ]
              : []),
          ],
          lineItems,
        },
      },
    },
  );

  const payload = (await response.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string; name: string; invoiceUrl: string };
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

  const data = payload?.data?.draftOrderCreate ?? {
    draftOrder: null,
    userErrors: [],
  };

  return data;
}
