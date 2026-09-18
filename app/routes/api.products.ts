import type { LoaderFunctionArgs } from "react-router";

import { searchProducts } from "../services/shopify/products.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";

  return Response.json(await searchProducts(request, query));
}
