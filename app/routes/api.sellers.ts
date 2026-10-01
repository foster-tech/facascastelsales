import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { searchBlingSellers } from "../services/bling.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const query = new URL(request.url).searchParams.get("query") || "";

  try {
    const sellers = await searchBlingSellers(query);
    return Response.json(sellers);
  } catch (error) {
    console.error("[bling/sellers] Search failed", {
      query: query.trim(),
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        message:
          "Não foi possível consultar os vendedores no Bling. Verifique a autorização e os escopos do aplicativo.",
      },
      { status: 502 },
    );
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  return Response.json(
    { success: false, message: "Vendedores devem ser cadastrados no Bling." },
    { status: 405, headers: { Allow: "GET" } },
  );
};
