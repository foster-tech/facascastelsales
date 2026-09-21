import type { LoaderFunctionArgs } from "react-router";
import { exchangeBlingAuthorizationCode } from "../services/bling.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error_description") || url.searchParams.get("error");

  if (oauthError) {
    return new Response(`Autorização do Bling negada: ${oauthError}`, { status: 400 });
  }

  if (!code || !state) {
    return new Response("Callback do Bling sem code ou state.", { status: 400 });
  }

  const storedState = await db.blingOAuthState.findUnique({ where: { state } });
  await db.blingOAuthState.deleteMany({ where: { state } });

  if (!storedState || storedState.expiresAt.getTime() <= Date.now()) {
    return new Response("State OAuth do Bling inválido ou expirado.", { status: 400 });
  }

  try {
    await exchangeBlingAuthorizationCode(code);
    return new Response(
      "Integração com o Bling autorizada com sucesso. Você pode fechar esta janela.",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  } catch (error) {
    console.error("[bling-oauth] Authorization failed", error);
    return new Response("Não foi possível concluir a autorização do Bling.", { status: 502 });
  }
};