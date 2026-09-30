import db from "../db.server";
import type { BlingOrderSync, BlingOrderSyncStatus } from "@prisma/client";

const blingApiBaseUrl = process.env.BLING_API_URL || "https://api.bling.com.br/Api/v3";
const blingTokenUrl = `${blingApiBaseUrl}/oauth/token`;
const blingTokenId = "default";
const tokenSafetyMarginMs = 5 * 60 * 1000;
const blingRequestIntervalMs = 400;

type BlingTokenPayload = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
};

export type BlingOrder = {
  id: number | string;
  numero?: number;
  numeroLoja?: string | null;
  loja?: unknown;
  vendedor?: unknown;
  [key: string]: unknown;
};

type BlingOrderSearchResult = {
  id: number | string;
  numero?: number;
  numeroLoja?: string;
};

type BlingSeller = {
  id?: number | string;
  contato?: {
    nome?: string;
  };
};

export class BlingRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlingRateLimitError";
  }
}

const describeBlingError = (value: unknown) => {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "Resposta de erro não serializável";
    }
  }

  return "Resposta de erro vazia";
};

const getBlingCredentials = () => {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Configure BLING_CLIENT_ID e BLING_CLIENT_SECRET.");
  }

  return { clientId, clientSecret };
};

let refreshPromise: Promise<string> | null = null;
let requestQueue = Promise.resolve();
let lastBlingRequestAt = 0;

const waitForBlingRequestSlot = async () => {
  const previousRequest = requestQueue;
  let releaseQueue!: () => void;
  requestQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await previousRequest;
  const waitMs = Math.max(
    0,
    blingRequestIntervalMs - (Date.now() - lastBlingRequestAt),
  );
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastBlingRequestAt = Date.now();
  releaseQueue();
};

async function requestBlingToken(body: URLSearchParams) {
  const { clientId, clientSecret } = getBlingCredentials();
  const response = await fetch(blingTokenUrl, {
    method: "POST",
    headers: {
      Accept: "1.0",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "enable-jwt": "1",
    },
    body,
  });
  const responseBody = await response.text();
  let payload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: unknown;
    error_description?: unknown;
  } = {};

  try {
    payload = JSON.parse(responseBody) as typeof payload;
  } catch {
    throw new Error(
      `Não foi possível renovar o token Bling: ${responseBody || `HTTP ${response.status}`}`,
    );
  }

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Não foi possível renovar o token Bling: ${describeBlingError(payload.error_description || payload.error || `HTTP ${response.status}`)}`,
    );
  }

  if (!payload.refresh_token || !payload.expires_in) {
    throw new Error("Resposta OAuth do Bling não contém refresh_token ou expires_in.");
  }

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: payload.expires_in,
    scope: payload.scope,
  } satisfies BlingTokenPayload;
}

async function persistBlingToken(payload: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}) {
  return db.blingOAuthToken.upsert({
    where: { id: blingTokenId },
    create: {
      id: blingTokenId,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: new Date(Date.now() + payload.expires_in * 1000),
      scope: payload.scope || null,
    },
    update: {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: new Date(Date.now() + payload.expires_in * 1000),
      scope: payload.scope || null,
    },
  });
}

export async function exchangeBlingAuthorizationCode(code: string) {
  const redirectUri = process.env.BLING_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("Configure BLING_REDIRECT_URI.");
  }

  const payload = await requestBlingToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  );
  await persistBlingToken(payload);
}

export async function getValidBlingAccessToken(forceRefresh = false, failedToken?: string) {
  const stored = await db.blingOAuthToken.findUnique({ where: { id: blingTokenId } });
  if (!stored) {
    throw new Error("Bling ainda não foi autorizado. Acesse /api/bling/auth.");
  }

  const tokenIsValid = stored.expiresAt.getTime() - Date.now() > tokenSafetyMarginMs;
  if (!forceRefresh && tokenIsValid) {
    return stored.accessToken;
  }

  if (forceRefresh && failedToken && stored.accessToken !== failedToken && tokenIsValid) {
    return stored.accessToken;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    console.log("[bling-oauth] Refreshing token");
    const latest = await db.blingOAuthToken.findUnique({ where: { id: blingTokenId } });
    if (!latest) {
      throw new Error("Bling ainda não foi autorizado. Acesse /api/bling/auth.");
    }

    if (failedToken && latest.accessToken !== failedToken && latest.expiresAt.getTime() - Date.now() > tokenSafetyMarginMs) {
      return latest.accessToken;
    }

    const payload = await requestBlingToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: latest.refreshToken,
      }),
    );
    await persistBlingToken(payload);
    console.log("[bling-oauth] Token refreshed successfully");
    return payload.access_token;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

const blingFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const request = async (token: string) => fetch(`${blingApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "enable-jwt": "1",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const executeRequest = async (token: string) => {
    await waitForBlingRequestSlot();
    return request(token);
  };

  let token = await getValidBlingAccessToken();
  let response = await executeRequest(token);

  if (response.status === 401) {
    token = await getValidBlingAccessToken(true, token);
    response = await executeRequest(token);
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds = Number(retryAfterHeader || 1);
    const retryAfterMs = Math.min(
      5000,
      Math.max(400, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 1000),
    );

    console.warn(`[bling] Rate limit atingido; retry em ${retryAfterMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    response = await executeRequest(token);
  }

  const body = await response.text();
  let payload: unknown = null;

  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = body;
    }
  }

  if (!response.ok) {
    const message = `Bling respondeu ${response.status}: ${JSON.stringify(payload)}`;
    if (response.status === 429) {
      throw new BlingRateLimitError(message);
    }
    throw new Error(message);
  }

  return payload as T;
};

export async function findBlingOrderByShopifyOrder(
  shopifyOrderId: string,
): Promise<BlingOrderSearchResult | null> {
  const searchedId = shopifyOrderId.trim();
  const params = new URLSearchParams();
  params.append("numerosLojas[]", searchedId);

  const response = await blingFetch<{ data?: unknown }>(
    `/pedidos/vendas?${params.toString()}`,
  );
  const orders = Array.isArray(response?.data) ? response.data : [];
  const matches = orders.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }

    const item = candidate as Partial<BlingOrder>;
    return typeof item.numeroLoja === "string"
      && item.numeroLoja.trim() === searchedId;
  });
  const matchedOrder = orders.length === 1 && matches.length === 1
    ? matches[0] as Partial<BlingOrder>
    : null;
  const matchedId = matchedOrder
    && ((typeof matchedOrder.id === "number" && Number.isSafeInteger(matchedOrder.id))
      || (typeof matchedOrder.id === "string" && matchedOrder.id.trim().length > 0))
    ? matchedOrder.id
    : null;

  console.log("[bling] Shopify order lookup completed", {
    shopifyOrderId: searchedId,
    resultCount: orders.length,
    matched: matchedId !== null,
    blingOrderId: matchedId,
  });

  if (!matchedOrder || matchedId === null) {
    return null;
  }

  return {
    id: typeof matchedId === "string" ? matchedId.trim() : matchedId,
    ...(typeof matchedOrder.numero === "number" ? { numero: matchedOrder.numero } : {}),
    numeroLoja: searchedId,
  };
}

const normalizeName = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .toLocaleLowerCase("pt-BR");

const parseBlingNumericId = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return null;
  }

  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function findBlingSellerIdByName(sellerName: string): Promise<number> {
  const params = new URLSearchParams({
    nomeContato: sellerName,
    situacaoContato: "A",
    limite: "100",
  });
  const response = await blingFetch<{ data?: unknown }>(
    `/vendedores?${params.toString()}`,
  );
  const sellers = Array.isArray(response?.data)
    ? response.data
    : response?.data && typeof response.data === "object"
      ? [response.data]
      : [];
  const normalizedSellerName = normalizeName(sellerName);
  const matches = sellers.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }

    const seller = candidate as BlingSeller;
    return typeof seller.contato?.nome === "string"
      && normalizeName(seller.contato.nome) === normalizedSellerName
      && parseBlingNumericId(seller.id) !== null;
  }) as BlingSeller[];

  if (matches.length !== 1) {
    throw new Error(
      `Esperado um vendedor ativo no Bling com o nome "${sellerName}", encontrados: ${matches.length}.`,
    );
  }

  return parseBlingNumericId(matches[0].id)!;
}

async function getBlingOrderDetails(orderId: BlingOrderSearchResult["id"]): Promise<BlingOrder | null> {
  const response = await blingFetch<{ data?: unknown }>(`/pedidos/vendas/${orderId}`);
  const order = response?.data && typeof response.data === "object" ? response.data : response;

  if (!order || typeof order !== "object") {
    console.log("[bling] Order not found or response without id");
    return null;
  }

  const item = order as Partial<BlingOrder>;
  const hasValidId = (typeof item.id === "number" && Number.isFinite(item.id))
    || (typeof item.id === "string" && item.id.trim().length > 0);
  if (!hasValidId) {
    console.log("[bling] Order not found or response without id");
    return null;
  }

  return item as BlingOrder;
}

export async function updateBlingOrderSeller(
  order: BlingOrder,
  sellerId: number,
): Promise<BlingOrder> {
  // `loja` is optional (and not nullable) in the official PUT schema. Omitting
  // it is the supported payload shape for "Nenhuma"; null and id 0 are not.
  const {
    id: _ignoredId,
    loja: _ignoredStore,
    notaFiscal: _ignoredInvoice,
    situacao: _ignoredStatus,
    total: _ignoredTotal,
    totalProdutos: _ignoredProductsTotal,
    ...currentOrder
  } = order;
  const payload = {
    ...currentOrder,
    vendedor: { id: sellerId },
  };

  return blingFetch<BlingOrder>(`/pedidos/vendas/${order.id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function processBlingOrderSync(sync: BlingOrderSync) {
  console.log("[bling] Sync processing started", {
    syncId: sync.id,
    shopDomain: sync.shopDomain,
    shopifyOrderId: sync.shopifyOrderId,
    shopifyOrderName: sync.shopifyOrderName,
    status: sync.status,
    attempts: sync.attempts,
    hasSellerName: Boolean(sync.sellerName),
  });

  if (!sync.sellerName) {
    console.error("[bling] Sync processing stopped: seller is missing", {
      syncId: sync.id,
      shopifyOrderName: sync.shopifyOrderName,
    });
    throw new Error("Sincronização sem vendedor associado.");
  }

  const blingOrder = await findBlingOrderByShopifyOrder(sync.shopifyOrderId);

  if (!blingOrder || !blingOrder.id) {
    const pendingSync = await db.blingOrderSync.update({
      where: { id: sync.id },
      data: {
        status: "PENDING",
        attempts: { increment: 1 },
        lastError: "Pedido ainda não importado no Bling.",
      },
    });
    console.log("[bling] Sync kept pending", {
      syncId: pendingSync.id,
      status: pendingSync.status,
      attempts: pendingSync.attempts,
      lastError: pendingSync.lastError,
    });
    return pendingSync;
  }

  const blingOrderDetails = await getBlingOrderDetails(blingOrder.id);
  if (!blingOrderDetails || !blingOrderDetails.id) {
    console.warn("[bling] Order details response has no valid id", {
      syncId: sync.id,
      requestedBlingOrderId: blingOrder.id,
      shopifyOrderName: sync.shopifyOrderName,
    });
    const pendingSync = await db.blingOrderSync.update({
      where: { id: sync.id },
      data: {
        status: "PENDING",
        attempts: { increment: 1 },
        lastError: "Pedido encontrado no Bling sem ID v\u00e1lido.",
      },
    });
    console.log("[bling] Sync kept pending", {
      syncId: pendingSync.id,
      status: pendingSync.status,
      attempts: pendingSync.attempts,
      lastError: pendingSync.lastError,
    });
    return pendingSync;
  }

  const blingSellerId = await findBlingSellerIdByName(sync.sellerName);
  console.log("[bling] Updating Bling order", {
    syncId: sync.id,
    blingOrderId: blingOrderDetails.id,
    blingSellerId,
    storeFieldOmitted: true,
  });
  await updateBlingOrderSeller(blingOrderDetails, blingSellerId);
  console.log("[bling] Bling order update completed", {
    syncId: sync.id,
    blingOrderId: blingOrderDetails.id,
  });

  const synchronizedSync = await db.blingOrderSync.update({
    where: { id: sync.id },
    data: {
      blingOrderId: String(blingOrderDetails.id),
      status: "SYNCED",
      attempts: { increment: 1 },
      lastError: null,
    },
  });
  console.log("[bling] Sync marked as synchronized", {
    syncId: synchronizedSync.id,
    status: synchronizedSync.status,
    attempts: synchronizedSync.attempts,
    blingOrderId: synchronizedSync.blingOrderId,
  });
  return synchronizedSync;
}

export async function markBlingOrderSyncFailed(
  syncId: string,
  error: unknown,
): Promise<BlingOrderSync> {
  return db.blingOrderSync.update({
    where: { id: syncId },
    data: {
      status: "FAILED" as BlingOrderSyncStatus,
      attempts: { increment: 1 },
      lastError: error instanceof Error ? error.message : String(error),
    },
  });
}
