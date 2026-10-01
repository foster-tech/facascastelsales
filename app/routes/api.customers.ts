import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { searchBlingContacts } from "../services/bling.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";

  return Response.json(await searchBlingContacts(query));
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.admin(request);
  return Response.json(
    { success: false, message: "Clientes devem ser cadastrados no Bling." },
    { status: 405, headers: { Allow: "GET" } },
  );
}
