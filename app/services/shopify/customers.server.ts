import { authenticate } from "../../shopify.server";

export type CustomerSearchResult = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
};

export async function searchCustomers(
  request: Request,
  query: string,
): Promise<CustomerSearchResult[]> {
  const { admin } = await authenticate.admin(request);
  const normalized = query.trim();

  if (!normalized) {
    return [];
  }

  const response = await admin.graphql(
    `#graphql
      query SearchCustomers($query: String!) {
        customers(first: 8, query: $query) {
          nodes {
            id
            firstName
            lastName
            email
            phone
          }
        }
      }`,
    {
      variables: {
        query: normalized,
      },
    },
  );

  const payload = await response.json();
  const nodes = payload?.data?.customers?.nodes ?? [];

  return nodes.map((customer: any) => ({
    id: customer.id,
    name: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "Cliente",
    email: customer.email,
    phone: customer.phone,
  }));
}

export async function createCustomer(
  request: Request,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  },
) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      mutation CustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
            firstName
            lastName
            email
            phone
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
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone || null,
        },
      },
    },
  );

  const payload = await response.json();
  return payload?.data?.customerCreate ?? { customer: null, userErrors: [] };
}
