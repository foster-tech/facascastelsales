import { createHmac } from "node:crypto";
import type {
  BlingOrderSync,
  BlingWebhookEvent,
  BlingWebhookEventStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({ default: {} }));
vi.mock("./bling.server", () => ({ processBlingOrderSync: vi.fn() }));

import {
  BlingWebhookIgnoredEventError,
  parseBlingOrderCreatedWebhook,
  parseBlingWebhookEnvelope,
  processBlingWebhookEventWith,
  verifyBlingWebhookSignature,
  type BlingWebhookProcessingDependencies,
} from "./bling-webhook.server";

const now = new Date("2026-10-01T12:00:00.000Z");

const createEvent = (): BlingWebhookEvent => ({
  eventId: "event-1",
  event: "order.created",
  version: "v1",
  companyId: "company-1",
  blingOrderId: "9001",
  shopifyOrderId: "18912198951191",
  payload: {},
  status: "PENDING",
  attempts: 0,
  lastError: null,
  processingStartedAt: null,
  processedAt: null,
  syncId: null,
  receivedAt: now,
  updatedAt: now,
});

const createSync = (): BlingOrderSync => ({
  id: "sync-1",
  shopDomain: "test.myshopify.com",
  shopifyOrderId: "18912198951191",
  shopifyOrderName: "#4681",
  sellerId: "123",
  sellerName: "Vendedor",
  blingContactId: null,
  blingContactName: null,
  blingOrderId: null,
  webhookId: "shopify-webhook-1",
  status: "PENDING",
  attempts: 0,
  lastError: null,
  createdAt: now,
  updatedAt: now,
});

function createDependencies(options?: {
  syncs?: BlingOrderSync[];
  synchronize?: (
    sync: BlingOrderSync,
    blingOrderId: string,
  ) => Promise<BlingOrderSync>;
}) {
  let event = createEvent();
  const syncs = options?.syncs || [];
  const synchronize = vi.fn(
    options?.synchronize ||
      (async (sync: BlingOrderSync, blingOrderId: string) => ({
        ...sync,
        blingOrderId,
        status: "SYNCED" as const,
      })),
  );

  const dependencies: BlingWebhookProcessingDependencies = {
    claimEvent: vi.fn(async () => {
      if (event.status !== "PENDING" && event.status !== "FAILED") {
        return null;
      }
      event = {
        ...event,
        status: "PROCESSING",
        attempts: event.attempts + 1,
        processingStartedAt: now,
      };
      return event;
    }),
    findSyncs: vi.fn(async (shopifyOrderId) =>
      syncs.filter((sync) => sync.shopifyOrderId === shopifyOrderId),
    ),
    linkEventToSync: vi.fn(async (_eventId, sync, blingOrderId) => {
      const linked = { ...sync, blingOrderId };
      const index = syncs.findIndex((candidate) => candidate.id === sync.id);
      if (index >= 0) {
        syncs[index] = linked;
      }
      event = { ...event, syncId: sync.id };
      return linked;
    }),
    synchronize,
    updateEvent: vi.fn(
      async (
        _eventId: string,
        status: BlingWebhookEventStatus,
        lastError: string | null,
      ) => {
        event = {
          ...event,
          status,
          lastError,
          processingStartedAt: null,
          processedAt: status === "PROCESSED" ? now : null,
        };
        return event;
      },
    ),
    getEvent: vi.fn(async () => event),
  };

  return { dependencies, syncs, synchronize, getEvent: () => event };
}

describe("Bling webhook signature", () => {
  it("accepts the exact raw body signed with HMAC-SHA256", () => {
    const body = JSON.stringify({ event: "order.created", eventId: "event-1" });
    const secret = "test-secret";
    const digest = createHmac("sha256", secret)
      .update(body, "utf8")
      .digest("hex");

    expect(
      verifyBlingWebhookSignature(
        Buffer.from(body, "utf8"),
        `sha256=${digest}`,
        secret,
      ),
    ).toBe(true);
    expect(
      verifyBlingWebhookSignature(`${body} `, `sha256=${digest}`, secret),
    ).toBe(false);
    expect(verifyBlingWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyBlingWebhookSignature(body, "sha256=invalid", secret)).toBe(
      false,
    );
  });
});

describe("Bling order.created payload", () => {
  it("accepts numeroLoja as the arbitrary non-empty string documented by Bling", () => {
    const envelope = parseBlingWebhookEnvelope(
      JSON.stringify({
        eventId: "event-1",
        companyId: "company-1",
        version: "v1",
        event: "order.created",
        data: { id: 9001, numeroLoja: "Loja_123" },
      }),
    );

    expect(parseBlingOrderCreatedWebhook(envelope).data).toEqual({
      id: "9001",
      numeroLoja: "Loja_123",
    });
  });

  it("classifies an empty numeroLoja as an ignored order", () => {
    const envelope = parseBlingWebhookEnvelope(
      JSON.stringify({
        eventId: "event-1",
        companyId: "company-1",
        version: "v1",
        event: "order.created",
        data: { id: 9001, numeroLoja: null },
      }),
    );

    expect(() => parseBlingOrderCreatedWebhook(envelope)).toThrow(
      BlingWebhookIgnoredEventError,
    );
  });
});

describe("Bling order.created processing", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("does not process the same event twice", async () => {
    const state = createDependencies({ syncs: [createSync()] });

    const first = await processBlingWebhookEventWith(
      "event-1",
      state.dependencies,
    );
    const duplicate = await processBlingWebhookEventWith(
      "event-1",
      state.dependencies,
    );

    expect(first.outcome).toBe("synchronized");
    expect(duplicate.outcome).toBe("already-processed");
    expect(state.synchronize).toHaveBeenCalledTimes(1);
  });

  it("keeps the event pending when it arrives before orders/paid", async () => {
    const state = createDependencies();

    const earlyResult = await processBlingWebhookEventWith(
      "event-1",
      state.dependencies,
    );
    expect(earlyResult.outcome).toBe("waiting-for-shopify");
    expect(state.getEvent().status).toBe("PENDING");

    state.syncs.push(createSync());
    const recoveredResult = await processBlingWebhookEventWith(
      "event-1",
      state.dependencies,
    );

    expect(recoveredResult.outcome).toBe("synchronized");
    expect(state.getEvent().status).toBe("PROCESSED");
    expect(state.synchronize).toHaveBeenCalledTimes(1);
  });

  it("records an update failure without marking the event as processed", async () => {
    const state = createDependencies({
      syncs: [createSync()],
      synchronize: async () => {
        throw new Error("Bling update failed");
      },
    });

    const result = await processBlingWebhookEventWith(
      "event-1",
      state.dependencies,
    );

    expect(result.outcome).toBe("failed");
    expect(state.getEvent().status).toBe("FAILED");
    expect(state.getEvent().lastError).toBe("Bling update failed");
  });
});
