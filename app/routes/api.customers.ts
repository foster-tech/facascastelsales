import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  createCustomer,
  searchCustomers,
} from "../services/shopify/customers.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";

  return Response.json(await searchCustomers(request, query));
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const raw = String(formData.get("payload") ?? "{}");

  const payload = JSON.parse(raw);
  const result = await createCustomer(request, payload);

  if (result?.userErrors?.length) {
    return Response.json({ success: false, userErrors: result.userErrors }, { status: 400 });
  }

  return Response.json({ success: true, customer: result.customer });
}
