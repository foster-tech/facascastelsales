import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  BlingOrderSync,
  BlingWebhookEvent,
  BlingWebhookEventStatus,
  Prisma,
} from "@prisma/client";
import db from "../db.server";
import { processBlingOrderSync } from "./bling.server";

const processingLeaseMs = 5 * 60 * 1000;

export type BlingOrderCreatedWebhook = {
  eventId: string;
  companyId: string;
  version: "v1";
  event: "order.created";
  data: {
    id: string;
    numeroLoja: string;
  };
  rawPayload: Record<string, unknown>;
};

export class BlingWebhookIgnoredEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlingWebhookIgnoredEventError";
  }
}

type BlingWebhookEnvelope = {
  eventId: string;
  companyId: string;
  version: string;
  event: string;
  data: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
};

export type BlingWebhookProcessingResult =
  | {
      outcome: "processing" | "already-processed";
      event: BlingWebhookEvent | null;
    }
  | { outcome: "waiting-for-shopify"; event: BlingWebhookEvent }
  | { outcome: "ignored" | "failed"; event: BlingWebhookEvent }
  | { outcome: "synchronized"; event: BlingWebhookEvent; sync: BlingOrderSync };

export type BlingWebhookProcessingDependencies = {
  claimEvent: (eventId: string) => Promise<BlingWebhookEvent | null>;
  findSyncs: (shopifyOrderId: string) => Promise<BlingOrderSync[]>;
  linkEventToSync: (
    eventId: string,
    sync: BlingOrderSync,
    blingOrderId: string,
  ) => Promise<BlingOrderSync>;
  synchronize: (
    sync: BlingOrderSync,
    blingOrderId: string,
  ) => Promise<BlingOrderSync>;
  updateEvent: (
    eventId: string,
    status: BlingWebhookEventStatus,
    lastError: string | null,
  ) => Promise<BlingWebhookEvent>;
  getEvent: (eventId: string) => Promise<BlingWebhookEvent | null>;
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseRequiredString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const parseIdentifier = (value: unknown) => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }

  return parseRequiredString(value);
};

const parsePositiveNumericId = (value: unknown) => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return null;
  }

  return value.trim();
};

export function verifyBlingWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null,
  clientSecret: string | undefined,
) {
  if (!signatureHeader || !clientSecret) {
    return false;
  }

  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
  if (!match) {
    return false;
  }

  const received = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", clientSecret).update(rawBody).digest();

  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export function parseBlingWebhookEnvelope(
  rawBody: string,
): BlingWebhookEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("Payload JSON do webhook Bling inválido.");
  }

  const envelope = asObject(parsed);
  const data = asObject(envelope?.data);
  const eventId = parseIdentifier(envelope?.eventId);
  const companyId = parseIdentifier(envelope?.companyId);
  const version = parseRequiredString(envelope?.version);
  const event = parseRequiredString(envelope?.event);

  if (!envelope || !data || !eventId || !companyId || !version || !event) {
    throw new Error(
      "Payload do webhook Bling não contém os campos obrigatórios.",
    );
  }

  return { eventId, companyId, version, event, data, rawPayload: envelope };
}

export function parseBlingOrderCreatedWebhook(
  envelope: BlingWebhookEnvelope,
): BlingOrderCreatedWebhook {
  if (envelope.event !== "order.created" || envelope.version !== "v1") {
    throw new Error("Evento Bling não suportado.");
  }

  const blingOrderId = parsePositiveNumericId(envelope.data.id);
  if (!blingOrderId) {
    throw new Error("Evento order.created sem data.id numérico válido.");
  }

  // `numeroLoja` is an arbitrary string in the official Bling webhook
  // contract. Keep its exact value so only an exact BlingOrderSync match can
  // authorize an update; do not infer a Shopify ID from prefixes or order names.
  const shopifyOrderId = parseIdentifier(envelope.data.numeroLoja);
  if (!shopifyOrderId) {
    throw new BlingWebhookIgnoredEventError(
      "Evento order.created sem data.numeroLoja; pedido fora do fluxo Shopify.",
    );
  }

  return {
    eventId: envelope.eventId,
    companyId: envelope.companyId,
    version: "v1",
    event: "order.created",
    data: {
      id: blingOrderId,
      numeroLoja: shopifyOrderId,
    },
    rawPayload: envelope.rawPayload,
  };
}

export async function persistBlingWebhookEvent(
  payload: BlingOrderCreatedWebhook,
) {
  const result = await db.blingWebhookEvent.createMany({
    data: {
      eventId: payload.eventId,
      event: payload.event,
      version: payload.version,
      companyId: payload.companyId,
      blingOrderId: payload.data.id,
      shopifyOrderId: payload.data.numeroLoja,
      payload: payload.rawPayload as Prisma.InputJsonValue,
    },
    skipDuplicates: true,
  });
  const event = await db.blingWebhookEvent.findUniqueOrThrow({
    where: { eventId: payload.eventId },
  });

  return { event, created: result.count === 1 };
}

const defaultDependencies: BlingWebhookProcessingDependencies = {
  async claimEvent(eventId) {
    const staleBefore = new Date(Date.now() - processingLeaseMs);
    const claimed = await db.blingWebhookEvent.updateMany({
      where: {
        eventId,
        OR: [
          { status: { in: ["PENDING", "FAILED"] } },
          {
            status: "PROCESSING",
            OR: [
              { processingStartedAt: null },
              { processingStartedAt: { lt: staleBefore } },
            ],
          },
        ],
      },
      data: {
        status: "PROCESSING",
        processingStartedAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
      },
    });

    if (claimed.count === 0) {
      return null;
    }

    return db.blingWebhookEvent.findUnique({ where: { eventId } });
  },

  findSyncs(shopifyOrderId) {
    return db.blingOrderSync.findMany({
      where: { shopifyOrderId },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
  },

  async linkEventToSync(eventId, sync, blingOrderId) {
    if (sync.blingOrderId && sync.blingOrderId !== blingOrderId) {
      throw new Error(
        "Evento Bling aponta para um pedido diferente do já associado.",
      );
    }

    if (sync.status === "SYNCED") {
      await db.blingWebhookEvent.update({
        where: { eventId },
        data: { syncId: sync.id },
      });
      return sync;
    }

    return db.$transaction(async (transaction) => {
      const associated = await transaction.blingOrderSync.updateMany({
        where: {
          id: sync.id,
          OR: [{ blingOrderId: null }, { blingOrderId }],
        },
        data: { blingOrderId },
      });
      if (associated.count !== 1) {
        throw new Error("Outra execução associou um pedido Bling diferente.");
      }

      await transaction.blingWebhookEvent.update({
        where: { eventId },
        data: { syncId: sync.id },
      });
      return transaction.blingOrderSync.findUniqueOrThrow({
        where: { id: sync.id },
      });
    });
  },

  synchronize(sync, blingOrderId) {
    return processBlingOrderSync(sync, { blingOrderId });
  },

  updateEvent(eventId, status, lastError) {
    return db.blingWebhookEvent.update({
      where: { eventId },
      data: {
        status,
        lastError,
        processingStartedAt: null,
        processedAt: status === "PROCESSED" ? new Date() : null,
      },
    });
  },

  getEvent(eventId) {
    return db.blingWebhookEvent.findUnique({ where: { eventId } });
  },
};

export async function processBlingWebhookEventWith(
  eventId: string,
  dependencies: BlingWebhookProcessingDependencies,
): Promise<BlingWebhookProcessingResult> {
  const event = await dependencies.claimEvent(eventId);
  if (!event) {
    const current = await dependencies.getEvent(eventId);
    return {
      outcome:
        current?.status === "PROCESSED" ? "already-processed" : "processing",
      event: current,
    };
  }

  console.log("[bling/webhook] Processing order.created", {
    eventId: event.eventId,
    companyId: event.companyId,
    shopifyOrderId: event.shopifyOrderId,
    blingOrderId: event.blingOrderId,
    attempt: event.attempts,
  });

  try {
    const syncs = await dependencies.findSyncs(event.shopifyOrderId);
    if (syncs.length === 0) {
      const pendingEvent = await dependencies.updateEvent(
        event.eventId,
        "PENDING",
        "Aguardando o webhook orders/paid da Shopify.",
      );
      console.log("[bling/webhook] Event waiting for Shopify synchronization", {
        eventId: event.eventId,
        shopifyOrderId: event.shopifyOrderId,
      });
      return { outcome: "waiting-for-shopify", event: pendingEvent };
    }

    if (syncs.length !== 1) {
      const failedEvent = await dependencies.updateEvent(
        event.eventId,
        "FAILED",
        "Mais de uma sincronização Shopify corresponde ao numeroLoja recebido.",
      );
      return { outcome: "failed", event: failedEvent };
    }

    const sync = syncs[0];
    if (sync.shopifyOrderId !== event.shopifyOrderId) {
      const ignoredEvent = await dependencies.updateEvent(
        event.eventId,
        "IGNORED",
        "numeroLoja não pertence ao fluxo de sincronização.",
      );
      return { outcome: "ignored", event: ignoredEvent };
    }

    if (sync.status === "SYNCED") {
      const status =
        !sync.blingOrderId || sync.blingOrderId === event.blingOrderId
          ? "PROCESSED"
          : "IGNORED";
      if (status === "PROCESSED") {
        await dependencies.linkEventToSync(event.eventId, sync, event.blingOrderId);
      }
      const completedEvent = await dependencies.updateEvent(
        event.eventId,
        status,
        status === "IGNORED"
          ? "Sincronização concluída com outro pedido Bling."
          : null,
      );
      return {
        outcome: status === "PROCESSED" ? "already-processed" : "ignored",
        event: completedEvent,
      };
    }

    const linkedSync = await dependencies.linkEventToSync(
      event.eventId,
      sync,
      event.blingOrderId,
    );
    const synchronizedSync = await dependencies.synchronize(
      linkedSync,
      event.blingOrderId,
    );

    if (synchronizedSync.status !== "SYNCED") {
      const pendingEvent = await dependencies.updateEvent(
        event.eventId,
        "PENDING",
        synchronizedSync.lastError || "Sincronização ainda pendente.",
      );
      return { outcome: "processing", event: pendingEvent };
    }

    const processedEvent = await dependencies.updateEvent(
      event.eventId,
      "PROCESSED",
      null,
    );
    console.log("[bling/webhook] Seller update confirmed", {
      eventId: event.eventId,
      syncId: synchronizedSync.id,
      shopifyOrderId: event.shopifyOrderId,
      blingOrderId: event.blingOrderId,
    });
    return {
      outcome: "synchronized",
      event: processedEvent,
      sync: synchronizedSync,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedEvent = await dependencies.updateEvent(
      event.eventId,
      "FAILED",
      message,
    );
    console.error("[bling/webhook] Event processing failed", {
      eventId: event.eventId,
      shopifyOrderId: event.shopifyOrderId,
      blingOrderId: event.blingOrderId,
      reason: message,
    });
    return { outcome: "failed", event: failedEvent };
  }
}

export function processBlingWebhookEvent(eventId: string) {
  return processBlingWebhookEventWith(eventId, defaultDependencies);
}

export function findRetryableBlingWebhookEvent(shopifyOrderId: string) {
  return db.blingWebhookEvent.findFirst({
    where: {
      shopifyOrderId,
      event: "order.created",
      version: "v1",
      status: { in: ["PENDING", "FAILED", "PROCESSING"] },
    },
    orderBy: { receivedAt: "asc" },
  });
}

export async function processBlingWebhookEventBatch(limit = 20) {
  const staleBefore = new Date(Date.now() - processingLeaseMs);
  const events = await db.blingWebhookEvent.findMany({
    where: {
      OR: [
        { status: { in: ["PENDING", "FAILED"] } },
        {
          status: "PROCESSING",
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lt: staleBefore } },
          ],
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { eventId: true },
  });

  let synchronized = 0;
  for (const event of events) {
    const result = await processBlingWebhookEvent(event.eventId);
    if (
      result.outcome === "synchronized" ||
      result.outcome === "already-processed"
    ) {
      synchronized += 1;
    }
  }

  return { loaded: events.length, synchronized };
}
