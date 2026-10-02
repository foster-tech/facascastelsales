import db from "../db.server";
import type { BlingOrderSync, BlingOrderSyncStatus } from "@prisma/client";

const blingApiBaseUrl =
  process.env.BLING_API_URL || "https://api.bling.com.br/Api/v3";
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

type BlingSellerApi = {
  id?: number | string;
  contato?: {
    id?: number | string;
    nome?: string;
    situacao?: string;
  };
};

type BlingContactAddressApi = {
  endereco?: string;
  cep?: string;
  bairro?: string;
  municipio?: string;
  uf?: string;
  numero?: string;
  complemento?: string;
};

type BlingContactApi = {
  id?: number | string;
  nome?: string;
  fantasia?: string;
  situacao?: string;
  tipo?: string;
  numeroDocumento?: string;
  telefone?: string;
  celular?: string;
  email?: string;
  endereco?: {
    geral?: BlingContactAddressApi;
    cobranca?: BlingContactAddressApi;
  };
  pais?: {
    nome?: string;
  };
};

export type BlingSellerResult = {
  id: string;
  name: string;
};

export type BlingContactAddress = {
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  provinceCode?: string;
  zip?: string;
};

export type BlingContactResult = {
  id: string;
  name: string;
  document?: string | null;
  email?: string | null;
  phone?: string | null;
  personType?: string | null;
  countryName?: string | null;
  generalAddress?: BlingContactAddress | null;
  billingAddress?: BlingContactAddress | null;
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
    throw new Error(
      "Resposta OAuth do Bling não contém refresh_token ou expires_in.",
    );
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

export async function getValidBlingAccessToken(
  forceRefresh = false,
  failedToken?: string,
) {
  const stored = await db.blingOAuthToken.findUnique({
    where: { id: blingTokenId },
  });
  if (!stored) {
    throw new Error("Bling ainda não foi autorizado. Acesse /api/bling/auth.");
  }

  const tokenIsValid =
    stored.expiresAt.getTime() - Date.now() > tokenSafetyMarginMs;
  if (!forceRefresh && tokenIsValid) {
    return stored.accessToken;
  }

  if (
    forceRefresh &&
    failedToken &&
    stored.accessToken !== failedToken &&
    tokenIsValid
  ) {
    return stored.accessToken;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    console.log("[bling-oauth] Refreshing token");
    const latest = await db.blingOAuthToken.findUnique({
      where: { id: blingTokenId },
    });
    if (!latest) {
      throw new Error(
        "Bling ainda não foi autorizado. Acesse /api/bling/auth.",
      );
    }

    if (
      failedToken &&
      latest.accessToken !== failedToken &&
      latest.expiresAt.getTime() - Date.now() > tokenSafetyMarginMs
    ) {
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
  const request = async (token: string) =>
    fetch(`${blingApiBaseUrl}${path}`, {
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
      Math.max(
        400,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 1000,
      ),
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
    return (
      typeof item.numeroLoja === "string" &&
      item.numeroLoja.trim() === searchedId
    );
  });
  const matchedOrder =
    orders.length === 1 && matches.length === 1
      ? (matches[0] as Partial<BlingOrder>)
      : null;
  const matchedId =
    matchedOrder &&
    ((typeof matchedOrder.id === "number" &&
      Number.isSafeInteger(matchedOrder.id)) ||
      (typeof matchedOrder.id === "string" &&
        matchedOrder.id.trim().length > 0))
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
    ...(typeof matchedOrder.numero === "number"
      ? { numero: matchedOrder.numero }
      : {}),
    numeroLoja: searchedId,
  };
}

const normalizeName = (value: string) =>
  value
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

const asBlingList = (value: unknown): unknown[] =>
  Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value]
      : [];

const mapBlingSeller = (candidate: unknown): BlingSellerResult | null => {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const seller = candidate as BlingSellerApi;
  const id = parseBlingNumericId(seller.id);
  const name = seller.contato?.nome?.trim();
  if (
    !id ||
    !name ||
    (seller.contato?.situacao && seller.contato.situacao !== "A")
  ) {
    return null;
  }

  return { id: String(id), name };
};

const mapBlingAddress = (
  address: BlingContactAddressApi | undefined,
): BlingContactAddress | null => {
  if (!address || !Object.values(address).some((value) => value?.trim())) {
    return null;
  }

  return {
    street: address.endereco?.trim() || undefined,
    number: address.numero?.trim() || undefined,
    complement: address.complemento?.trim() || undefined,
    neighborhood: address.bairro?.trim() || undefined,
    city: address.municipio?.trim() || undefined,
    provinceCode: address.uf?.trim().toUpperCase() || undefined,
    zip: address.cep?.trim() || undefined,
  };
};

const mapBlingContact = (candidate: unknown): BlingContactResult | null => {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const contact = candidate as BlingContactApi;
  const id = parseBlingNumericId(contact.id);
  const name = contact.nome?.trim();
  if (!id || !name || (contact.situacao && contact.situacao !== "A")) {
    return null;
  }

  return {
    id: String(id),
    name,
    document: contact.numeroDocumento?.trim() || null,
    email: contact.email?.trim() || null,
    phone: contact.celular?.trim() || contact.telefone?.trim() || null,
    personType: contact.tipo?.trim() || null,
    countryName: contact.pais?.nome?.trim() || null,
    generalAddress: mapBlingAddress(contact.endereco?.geral),
    billingAddress: mapBlingAddress(contact.endereco?.cobranca),
  };
};

export async function searchBlingSellers(
  query: string,
): Promise<BlingSellerResult[]> {
  const search = query.trim();
  const params = new URLSearchParams({
    situacaoContato: "A",
    limite: "20",
  });
  if (search) {
    params.set("nomeContato", search);
  }

  const response = await blingFetch<{ data?: unknown }>(
    `/vendedores?${params.toString()}`,
  );
  const returnedSellers = asBlingList(response?.data);
  let validSellers = returnedSellers
    .map(mapBlingSeller)
    .filter((seller): seller is BlingSellerResult => Boolean(seller));
  let usedActiveListFallback = false;
  let fallbackResultCount = 0;

  // O filtro nomeContato do Bling pode não retornar correspondências para buscas
  // parciais. Nesse caso, consulta a primeira página completa de vendedores ativos
  // e aplica uma comparação normalizada, sem acentos, no servidor.
  if (search && validSellers.length === 0) {
    usedActiveListFallback = true;
    const fallbackParams = new URLSearchParams({
      situacaoContato: "A",
      limite: "100",
    });
    const fallbackResponse = await blingFetch<{ data?: unknown }>(
      `/vendedores?${fallbackParams.toString()}`,
    );
    const normalizedSearch = normalizeName(search);
    const fallbackSellers = asBlingList(fallbackResponse?.data);
    fallbackResultCount = fallbackSellers.length;

    validSellers = fallbackSellers
      .map(mapBlingSeller)
      .filter((seller): seller is BlingSellerResult => Boolean(seller))
      .filter((seller) => normalizeName(seller.name).includes(normalizedSearch))
      .slice(0, 20);
  }

  console.info("[bling/sellers] Search completed", {
    query: search,
    resultCount: returnedSellers.length,
    fallbackResultCount,
    matchedCount: validSellers.length,
    usedActiveListFallback,
  });

  return validSellers;
}

export async function getBlingSellerById(
  id: string,
): Promise<BlingSellerResult> {
  const numericId = parseBlingNumericId(id);
  if (!numericId) {
    throw new Error("Selecione um vendedor válido do Bling.");
  }

  const response = await blingFetch<{ data?: unknown }>(
    `/vendedores/${numericId}`,
  );
  const seller = mapBlingSeller(response?.data);
  if (!seller) {
    throw new Error(
      "O vendedor selecionado não está ativo ou não existe mais no Bling.",
    );
  }

  return seller;
}

export async function searchBlingContacts(
  query: string,
): Promise<BlingContactResult[]> {
  const params = new URLSearchParams({
    criterio: "1",
    limite: "20",
  });
  const search = query.trim();
  if (search) {
    params.set("pesquisa", search);
  }

  const response = await blingFetch<{ data?: unknown }>(
    `/contatos?${params.toString()}`,
  );

  return asBlingList(response?.data)
    .map(mapBlingContact)
    .filter((contact): contact is BlingContactResult => Boolean(contact));
}

export async function getBlingContactById(
  id: string,
): Promise<BlingContactResult> {
  const numericId = parseBlingNumericId(id);
  if (!numericId) {
    throw new Error("Selecione um cliente válido do Bling.");
  }

  const response = await blingFetch<{ data?: unknown }>(
    `/contatos/${numericId}`,
  );
  const contact = mapBlingContact(response?.data);
  if (!contact) {
    throw new Error(
      "O cliente selecionado não está ativo ou não existe mais no Bling.",
    );
  }

  return contact;
}

async function findBlingSellerIdByName(sellerName: string): Promise<number> {
  const params = new URLSearchParams({
    nomeContato: sellerName,
    situacaoContato: "A",
    limite: "100",
  });
  const response = await blingFetch<{ data?: unknown }>(
    `/vendedores?${params.toString()}`,
  );
  const sellers = asBlingList(response?.data);
  const normalizedSellerName = normalizeName(sellerName);
  const matches = sellers.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }

    const seller = candidate as BlingSellerApi;
    return (
      typeof seller.contato?.nome === "string" &&
      normalizeName(seller.contato.nome) === normalizedSellerName &&
      parseBlingNumericId(seller.id) !== null
    );
  }) as BlingSellerApi[];

  if (matches.length !== 1) {
    throw new Error(
      `Esperado um vendedor ativo no Bling com o nome "${sellerName}", encontrados: ${matches.length}.`,
    );
  }

  return parseBlingNumericId(matches[0].id)!;
}

async function getBlingOrderDetails(
  orderId: BlingOrderSearchResult["id"],
): Promise<BlingOrder | null> {
  const response = await blingFetch<{ data?: unknown }>(
    `/pedidos/vendas/${orderId}`,
  );
  const order =
    response?.data && typeof response.data === "object"
      ? response.data
      : response;

  if (!order || typeof order !== "object") {
    console.log("[bling] Order not found or response without id");
    return null;
  }

  const item = order as Partial<BlingOrder>;
  const hasValidId =
    (typeof item.id === "number" && Number.isFinite(item.id)) ||
    (typeof item.id === "string" && item.id.trim().length > 0);
  if (!hasValidId) {
    console.log("[bling] Order not found or response without id");
    return null;
  }

  return item as BlingOrder;
}

export async function updateBlingOrderAssignments(
  order: BlingOrder,
  sellerId: number,
  contactId?: number | null,
): Promise<BlingOrder> {
  // `loja` is optional (and not nullable) in the official PUT schema. Omitting
  // it is the supported payload shape for "Nenhuma"; null and id 0 are not.
  const currentOrder = { ...order };
  for (const readOnlyOrOmittedField of [
    "id",
    "loja",
    "notaFiscal",
    "situacao",
    "total",
    "totalProdutos",
  ]) {
    delete currentOrder[readOnlyOrOmittedField];
  }
  const payload = {
    ...currentOrder,
    vendedor: { id: sellerId },
    ...(contactId ? { contato: { id: contactId } } : {}),
  };

  return blingFetch<BlingOrder>(`/pedidos/vendas/${order.id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function processBlingOrderSync(
  sync: BlingOrderSync,
  options: { blingOrderId?: string } = {},
) {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const knownBlingOrderId =
    options.blingOrderId || sync.blingOrderId || undefined;
  const claimed = await db.blingOrderSync.updateMany({
    where: {
      id: sync.id,
      OR: [
        { status: { in: ["PENDING", "FAILED"] } },
        { status: "PROCESSING", updatedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      lastError: null,
      ...(knownBlingOrderId ? { blingOrderId: knownBlingOrderId } : {}),
    },
  });

  if (claimed.count === 0) {
    const currentSync = await db.blingOrderSync.findUnique({
      where: { id: sync.id },
    });
    if (!currentSync) {
      throw new Error("Sincronização não encontrada.");
    }
    console.log("[bling] Sync processing skipped", {
      syncId: currentSync.id,
      status: currentSync.status,
    });
    return currentSync;
  }

  const claimedSync = await db.blingOrderSync.findUniqueOrThrow({
    where: { id: sync.id },
  });
  sync = claimedSync;
  try {
    console.log("[bling] Sync processing started", {
      syncId: sync.id,
      shopDomain: sync.shopDomain,
      shopifyOrderId: sync.shopifyOrderId,
      shopifyOrderName: sync.shopifyOrderName,
      status: sync.status,
      attempts: sync.attempts,
      hasSellerName: Boolean(sync.sellerName),
      hasSellerId: Boolean(sync.sellerId),
      hasBlingContactId: Boolean(sync.blingContactId),
    });

    if (!sync.sellerName && !sync.sellerId) {
      console.error("[bling] Sync processing stopped: seller is missing", {
        syncId: sync.id,
        shopifyOrderName: sync.shopifyOrderName,
      });
      throw new Error("Sincronização sem vendedor associado.");
    }

    const blingOrder = knownBlingOrderId
      ? { id: knownBlingOrderId, numeroLoja: sync.shopifyOrderId }
      : await findBlingOrderByShopifyOrder(sync.shopifyOrderId);

    if (!blingOrder || !blingOrder.id) {
      const pendingSync = await db.blingOrderSync.update({
        where: { id: sync.id },
        data: {
          status: "PENDING",
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

    const orderShopifyId =
      typeof blingOrderDetails.numeroLoja === "string" ||
      typeof blingOrderDetails.numeroLoja === "number"
        ? String(blingOrderDetails.numeroLoja).trim()
        : null;
    if (orderShopifyId !== sync.shopifyOrderId) {
      throw new Error(
        "O numeroLoja do pedido Bling não corresponde ao ID interno do pedido Shopify.",
      );
    }

    const blingSellerId =
      parseBlingNumericId(sync.sellerId) ||
      (sync.sellerName ? await findBlingSellerIdByName(sync.sellerName) : null);
    if (!blingSellerId) {
      throw new Error("Sincronização sem ID válido de vendedor do Bling.");
    }
    const blingContactId = parseBlingNumericId(sync.blingContactId);
    console.log("[bling] Seller resolved for order update", {
      syncId: sync.id,
      blingOrderId: blingOrderDetails.id,
      blingSellerId,
      blingContactId,
      storeFieldOmitted: true,
    });
    await updateBlingOrderAssignments(
      blingOrderDetails,
      blingSellerId,
      blingContactId,
    );
    console.log("[bling] Bling order update completed", {
      syncId: sync.id,
      blingOrderId: blingOrderDetails.id,
    });

    const confirmedOrder = await getBlingOrderDetails(blingOrderDetails.id);
    const confirmedSellerId =
      confirmedOrder?.vendedor && typeof confirmedOrder.vendedor === "object"
        ? parseBlingNumericId((confirmedOrder.vendedor as { id?: unknown }).id)
        : null;
    console.log("[bling] Seller confirmation completed", {
      syncId: sync.id,
      blingOrderId: blingOrderDetails.id,
      expectedSellerId: blingSellerId,
      confirmedSellerId,
      matched: confirmedSellerId === blingSellerId,
    });
    if (confirmedSellerId !== blingSellerId) {
      throw new Error(
        "O Bling não confirmou o vendedor esperado após a atualização.",
      );
    }

    const synchronizedSync = await db.blingOrderSync.update({
      where: { id: sync.id },
      data: {
        blingOrderId: String(blingOrderDetails.id),
        status: "SYNCED",
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
  } catch (error) {
    const status: BlingOrderSyncStatus =
      error instanceof BlingRateLimitError ? "PENDING" : "FAILED";
    await db.blingOrderSync.updateMany({
      where: { id: sync.id, status: "PROCESSING" },
      data: {
        status,
        lastError: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function markBlingOrderSyncFailed(
  syncId: string,
  error: unknown,
): Promise<BlingOrderSync> {
  return db.blingOrderSync.update({
    where: { id: syncId },
    data: {
      status: "FAILED" as BlingOrderSyncStatus,
      lastError: error instanceof Error ? error.message : String(error),
    },
  });
}
