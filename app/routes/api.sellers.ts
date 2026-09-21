import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createOrGetSeller, searchSellers } from "../services/sellers.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const query = new URL(request.url).searchParams.get("query") || "";
  return Response.json(await searchSellers(query));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  if (request.method !== "POST") {
    return Response.json(
      { success: false, message: "Método inválido" },
      { status: 405 },
    );
  }

  const payload = (await request.json()) as { name?: string };

  try {
    const seller = await createOrGetSeller(payload.name || "");
    return Response.json({ success: true, seller });
  } catch (error) {
    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Não foi possível criar o vendedor.",
      },
      { status: 400 },
    );
  }
};
