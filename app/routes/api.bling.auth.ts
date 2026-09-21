import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { randomUUID } from "node:crypto";
import db from "../db.server";

const stateLifetimeMs = 10 * 60 * 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const clientId = process.env.BLING_CLIENT_ID;
  const redirectUri = process.env.BLING_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return new Response("Configure BLING_CLIENT_ID e BLING_REDIRECT_URI.", { status: 500 });
  }

  const state = randomUUID();
  await db.blingOAuthState.create({
    data: {
      state,
      expiresAt: new Date(Date.now() + stateLifetimeMs),
    },
  });

  const authorizationUrl = new URL("https://www.bling.com.br/Api/v3/oauth/authorize");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);

  throw redirect(authorizationUrl.toString());
};