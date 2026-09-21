import db from "../db.server";
import type { BlingOrderSync, BlingOrderSyncStatus } from "@prisma/client";

const blingApiBaseUrl =
  process.env.BLING_API_BASE_URL || "https://api.bling.com.br/Api/v3";

export type BlingOrder = {
  id: number | string;
  numeroLoja?: string | null;
  loja?: unknown;
  vendedor?: unknown;
  [key: string]: unknown;
};

const getBlingToken = () => {
  const token = process.env.BLING_ACCESS_TOKEN;
  if (!token) {
    throw new Error("BLING_ACCESS_TOKEN não configurado.");
  }
  return token;
};

const blingRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${blingApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${getBlingToken()}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

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
    throw new Error(`Bling respondeu ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload as T;
};

export async function findBlingOrderByShopifyOrder(
  shopifyOrderId: string,
  shopifyOrderName: string,
): Promise<BlingOrder | null> {
  for (let page = 1; page <= 5; page += 1) {
    const params = new URLSearchParams({ pagina: String(page), limite: "100" });
    const payload = await blingRequest<{ data?: BlingOrder[] }>(
      `/pedidos/vendas?${params.toString()}`,
    );
    const order = (payload.data || []).find((candidate) => {
      const externalNumber = String(candidate.numeroLoja || "");
      return externalNumber === shopifyOrderId || externalNumber === shopifyOrderName;
    });

    if (order) {
      return blingRequest<BlingOrder>(`/pedidos/vendas/${order.id}`);
    }

    if (!payload.data || payload.data.length < 100) {
      break;
    }
  }

  return null;
}

export async function updateBlingOrderSeller(
  order: BlingOrder,
  sellerName: string,
): Promise<BlingOrder> {
  const { loja: _ignoredStore, ...currentOrder } = order;
  const payload = {
    ...currentOrder,
    vendedor: { nome: sellerName },
  };
  const method = process.env.BLING_ORDER_UPDATE_METHOD || "PUT";

  return blingRequest<BlingOrder>(`/pedidos/vendas/${order.id}`, {
    method,
    body: JSON.stringify(payload),
  });
}

export async function processBlingOrderSync(sync: BlingOrderSync) {
  if (!sync.sellerName) {
    throw new Error("Sincronização sem vendedor associado.");
  }

  const blingOrder = await findBlingOrderByShopifyOrder(
    sync.shopifyOrderId,
    sync.shopifyOrderName,
  );

  if (!blingOrder) {
    console.log(`[bling] Shopify order not imported yet: ${sync.shopifyOrderName}`);
    return db.blingOrderSync.update({
      where: { id: sync.id },
      data: {
        status: "PENDING",
        attempts: { increment: 1 },
        lastError: "Pedido ainda não importado no Bling.",
      },
    });
  }

  console.log(`[bling] Order found: ${blingOrder.id}`);
  console.log(`[bling] Setting seller: ${sync.sellerName}`);
  console.log("[bling] Setting store: Nenhuma (loja omitida do payload)");
  await updateBlingOrderSeller(blingOrder, sync.sellerName);
  console.log("[bling] Order synchronized successfully");

  return db.blingOrderSync.update({
    where: { id: sync.id },
    data: {
      blingOrderId: String(blingOrder.id),
      status: "SYNCED",
      attempts: { increment: 1 },
      lastError: null,
    },
  });
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
