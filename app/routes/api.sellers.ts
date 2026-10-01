import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { searchBlingSellers } from "../services/bling.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const query = new URL(request.url).searchParams.get("query") || "";
  return Response.json(await searchBlingSellers(query));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  return Response.json(
    { success: false, message: "Vendedores devem ser cadastrados no Bling." },
    { status: 405, headers: { Allow: "GET" } },
  );
};
