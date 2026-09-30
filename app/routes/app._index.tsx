import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { createOrGetSeller, getActiveSeller } from "../services/sellers.server";
import { createCustomer as createShopifyCustomer } from "../services/shopify/customers.server";
import { createDraftOrder } from "../services/shopify/draft-orders.server";

type CustomerResult = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
};

type SellerResult = {
  id: string;
  name: string;
};

type ProductResult = {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku?: string | null;
  price: string;
  image?: string | null;
};

type ProductSort = "relevance" | "price-asc" | "price-desc" | "title";

type OrderItem = {
  localId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku?: string | null;
  image?: string | null;
  displayPrice: string;
  quantity: number;
  engravings: string[];
};

const formatPrice = (value: string | number) => {
  const numeric = Number(value || 0);
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number.isFinite(numeric) ? numeric : 0);
};

const generateLocalId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const parseJsonResponse = async (response: Response) => {
  const text = await response.text();

  if (!text.trim()) {
    return null;
  }

  const trimmedContent = text.trim();
  if (trimmedContent.startsWith("<")) {
    throw new Error(
      "O app respondeu com uma página HTML em vez de JSON. Isso normalmente indica sessão expirada, redirecionamento de autenticação ou loja inválida.",
    );
  }

  try {
    return JSON.parse(trimmedContent);
  } catch {
    throw new Error("Resposta inválida do servidor ao criar o pedido.");
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    if (request.method !== "POST") {
      return Response.json(
        { success: false, message: "Método inválido" },
        { status: 405 },
      );
    }

    const payload = await request.json();

    if (payload?.mode === "customer-create") {
      const result = await createShopifyCustomer(request, payload.payload);

      if (result?.userErrors?.length) {
        return Response.json(
          { success: false, message: result.userErrors[0].message },
          { status: 400 },
        );
      }

      return Response.json({ success: true, customer: result.customer });
    }

    if (payload?.mode === "seller-create") {
      const seller = await createOrGetSeller(String(payload.name || ""));
      return Response.json({ success: true, seller });
    }

    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
      return Response.json(
        { success: false, message: "Adicione ao menos um produto" },
        { status: 400 },
      );
    }

    if (!payload.sellerId) {
      return Response.json(
        { success: false, message: "Selecione o vendedor responsável pelo pedido." },
        { status: 400 },
      );
    }

    const seller = await getActiveSeller(String(payload.sellerId));

    const lineItems = payload.items.flatMap((item: any) => {
    const quantity = Math.max(1, Number(item.quantity || 1));
    const engravings = Array.isArray(item.engravings) ? item.engravings : [];

    if (!engravings.length || engravings.every((value: unknown) => !String(value ?? "").trim())) {
      return [{
        variantId: item.variantId,
        quantity,
        priceOverride: String(item.originalUnitPrice || "0"),
      }];
    }

    return Array.from({ length: quantity }, (_, index) => {
      const value = String(engravings[index] ?? "").trim();

      return {
        variantId: item.variantId,
        quantity: 1,
        priceOverride: String(item.originalUnitPrice || "0"),
        ...(value ? { customAttributes: [{ key: "Personalização", value }] } : {}),
      };
    });
    });

    const result = await createDraftOrder(request, {
      customerId: payload.customerId || null,
      note: payload.note || "",
      sellerId: seller.id,
      sellerName: seller.name,
      items: lineItems,
    });

    if (result.userErrors?.length) {
      return Response.json(
        { success: false, message: result.userErrors[0].message },
        { status: 400 },
      );
    }

    if (!result.draftOrder || !result.draftOrder.invoiceUrl) {
      return Response.json(
        { success: false, message: "Pedido criado, mas sem link de pagamento" },
        { status: 400 },
      );
    }

    return Response.json({ success: true, draftOrder: result.draftOrder });
  } catch (actionError) {
    console.error("Erro ao processar ação do pedido", actionError);

    if (actionError instanceof Response) {
      return actionError;
    }

    return Response.json(
      {
        success: false,
        message:
          actionError instanceof Error
            ? actionError.message
            : "Erro interno ao criar o pedido.",
      },
      { status: 500 },
    );
  }
};

export default function Index() {
  const [sellerQuery, setSellerQuery] = useState("");
  const [sellerResults, setSellerResults] = useState<SellerResult[]>([]);
  const [selectedSeller, setSelectedSeller] = useState<SellerResult | null>(null);
  const [sellerLoading, setSellerLoading] = useState(false);
  const [sellerError, setSellerError] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerResult[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerResult | null>(null);
  const [isCustomerOpen, setIsCustomerOpen] = useState(false);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const [newCustomer, setNewCustomer] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<ProductResult[]>([]);
  const [productLoading, setProductLoading] = useState(false);
  const [productSort, setProductSort] = useState<ProductSort>("relevance");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ name: string; invoiceUrl: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const draftOrderFetcher = useFetcher<any>();
  const sellerFetcher = useFetcher<any>();

  useEffect(() => {
    if (sellerFetcher.state !== "idle" || !sellerFetcher.data) {
      return;
    }

    const result = sellerFetcher.data;
    if (!result.success || !result.seller?.id) {
      setSellerError(result.message || "Não foi possível criar o vendedor.");
      return;
    }

    setSelectedSeller(result.seller);
    setSellerQuery("");
    setSellerResults([]);
    setSellerError("");
  }, [sellerFetcher.data, sellerFetcher.state]);

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      if (!sellerQuery.trim()) {
        setSellerResults([]);
        setSellerLoading(false);
        return;
      }

      setSellerLoading(true);
      setSellerError("");

      try {
        const response = await fetch(
          `/api/sellers?${new URLSearchParams({
            ...Object.fromEntries(new URLSearchParams(window.location.search)),
            query: sellerQuery,
          }).toString()}`,
          { credentials: "include" },
        );
        if (!response.ok) {
          throw new Error("Não foi possível buscar vendedores.");
        }
        setSellerResults((await response.json()) as SellerResult[]);
      } catch {
        setSellerError("Não foi possível carregar vendedores.");
      } finally {
        setSellerLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [sellerQuery]);

  useEffect(() => {
    if (draftOrderFetcher.state === "submitting") {
      setIsCreating(true);
      return;
    }

    if (draftOrderFetcher.state !== "idle" || !draftOrderFetcher.data) {
      return;
    }

    const result = draftOrderFetcher.data;
    if (!result.success) {
      setError(result.message || "Não foi possível criar o pedido.");
      setIsCreating(false);
      return;
    }

    setSuccess({
      name: result.draftOrder.name || "Pedido",
      invoiceUrl: result.draftOrder.invoiceUrl,
    });
    setIsCreating(false);
  }, [draftOrderFetcher.data, draftOrderFetcher.state]);

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      if (!customerQuery.trim()) {
        setCustomerResults([]);
        setCustomerLoading(false);
        return;
      }

      setCustomerLoading(true);
      setCustomerError("");

      try {
        const response = await fetch(
          `/api/customers?query=${encodeURIComponent(customerQuery)}`,
        );

        if (!response.ok) {
          throw new Error("Não foi possível buscar clientes");
        }

        const data = (await response.json()) as CustomerResult[];
        setCustomerResults(data);
      } catch {
        setCustomerError("Não foi possível carregar clientes.");
      } finally {
        setCustomerLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [customerQuery]);

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      if (!productQuery.trim()) {
        setProductResults([]);
        setProductLoading(false);
        return;
      }

      setProductLoading(true);

      try {
        const response = await fetch(
          `/api/products?query=${encodeURIComponent(productQuery)}`,
        );

        if (!response.ok) {
          throw new Error("Erro ao buscar produtos");
        }

        const data = (await response.json()) as ProductResult[];
        setProductResults(data);
      } catch {
        setError("Não foi possível buscar produtos.");
      } finally {
        setProductLoading(false);
      }
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [productQuery]);

  const subtotal = useMemo(
    () =>
      orderItems.reduce(
        (total, item) => total + Number(item.displayPrice || 0) * item.quantity,
        0,
      ),
    [orderItems],
  );

  const sortedProductResults = useMemo(() => {
    if (productSort === "relevance") {
      return productResults;
    }

    return [...productResults].sort((left, right) => {
      if (productSort === "title") {
        return left.productTitle.localeCompare(right.productTitle, "pt-BR");
      }

      const priceDifference = Number(left.price) - Number(right.price);
      return productSort === "price-asc" ? priceDifference : -priceDifference;
    });
  }, [productResults, productSort]);

  const addProduct = (product: ProductResult) => {
    setOrderItems((current) => [
      ...current,
      {
        localId: generateLocalId(),
        variantId: product.id,
        productTitle: product.productTitle,
        variantTitle: product.variantTitle,
        sku: product.sku,
        image: product.image,
        displayPrice: product.price,
        quantity: 1,
        engravings: [""],
      },
    ]);

    setProductQuery("");
    setProductResults([]);
  };

  const adjustQuantity = (localId: string, delta: number) => {
    setOrderItems((current) =>
      current.map((item) => {
        if (item.localId !== localId) {
          return item;
        }

        const nextQuantity = Math.max(1, item.quantity + delta);
        const nextEngravings = Array.from({ length: nextQuantity }, (_, index) => item.engravings[index] ?? "");

        return { ...item, quantity: nextQuantity, engravings: nextEngravings };
      }),
    );
  };

  const updateEngraving = (localId: string, index: number, value: string) => {
    setOrderItems((current) =>
      current.map((item) => {
        if (item.localId !== localId) {
          return item;
        }

        const nextEngravings = [...item.engravings];
        nextEngravings[index] = value;
        return { ...item, engravings: nextEngravings };
      }),
    );
  };

  const removeItem = (localId: string) => {
    setOrderItems((current) => current.filter((item) => item.localId !== localId));
  };

  const createCustomer = async () => {
    const payload = {
      firstName: newCustomer.firstName.trim(),
      lastName: newCustomer.lastName.trim(),
      email: newCustomer.email.trim(),
      phone: newCustomer.phone.trim(),
    };

    if (!payload.firstName || !payload.email) {
      setCustomerError("Informe nome e e-mail para criar o cliente.");
      return;
    }

    try {
      const response = await fetch(window.location.href, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "customer-create", payload }),
      });

      const result = await parseJsonResponse(response);
      if (!response.ok || !result?.customer?.id) {
        throw new Error(result?.message || "Não foi possível criar o cliente");
      }

      const customer = {
        id: result.customer.id,
        name:
          `${result.customer.firstName || ""} ${result.customer.lastName || ""}`.trim() ||
          "Cliente",
        email: result.customer.email,
        phone: result.customer.phone,
      };

      setSelectedCustomer(customer);
      setCustomerQuery("");
      setCustomerResults([]);
      setNewCustomer({ firstName: "", lastName: "", email: "", phone: "" });
    } catch (customerErrorMessage) {
      setCustomerError(
        customerErrorMessage instanceof Error
          ? customerErrorMessage.message
          : "Não foi possível criar o cliente.",
      );
    }
  };

  const createSeller = () => {
    const name = sellerQuery.trim();
    if (!name) {
      setSellerError("Informe o nome do vendedor.");
      return;
    }

    setSellerError("");
    sellerFetcher.submit(
      JSON.stringify({ name }),
      {
        method: "post",
        action: `/api/sellers${window.location.search}`,
        encType: "application/json",
      },
    );
  };

  const handleCreateDraftOrder = async () => {
    if (!selectedSeller) {
      setError("Selecione o vendedor responsável pelo pedido.");
      return;
    }

    if (orderItems.length === 0) {
      setError("Adicione ao menos um produto ao pedido.");
      return;
    }

    setError("");

    draftOrderFetcher.submit(
      JSON.stringify({
        sellerId: selectedSeller.id,
        customerId: selectedCustomer?.id ?? null,
        note,
        items: orderItems.map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity,
          originalUnitPrice: item.displayPrice,
          engravings: item.engravings,
        })),
      }),
      { method: "post", encType: "application/json" },
    );
  };

  const canCreateOrder = Boolean(selectedSeller) && orderItems.length > 0 && !isCreating;

  return (
    <s-page heading="Novo Pedido" inlineSize="large">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-heading>Vendedor</s-heading>
          {!selectedSeller ? (
            <>
              <s-text-field
                label="Buscar vendedor"
                value={sellerQuery}
                onInput={(event: any) => setSellerQuery(event.target.value || "")}
              />
              {sellerLoading && <s-paragraph>Buscando vendedores…</s-paragraph>}
              {sellerError && <s-banner tone="critical">{sellerError}</s-banner>}
              {sellerResults.length > 0 && (
                <s-stack direction="block" gap="base">
                  {sellerResults.map((seller) => (
                    <s-box
                      key={seller.id}
                      padding="base"
                      borderWidth="base"
                      borderRadius="base"
                    >
                      <s-stack direction="block" gap="base">
                        <s-text>{seller.name}</s-text>
                        <s-button onClick={() => setSelectedSeller(seller)}>
                          Selecionar
                        </s-button>
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              )}
              {sellerQuery.trim() && !sellerLoading && sellerResults.length === 0 && (
                <s-button
                  disabled={sellerFetcher.state !== "idle"}
                  onClick={createSeller}
                >
                  {sellerFetcher.state === "submitting"
                    ? "Criando vendedor…"
                    : `+ Criar vendedor "${sellerQuery.trim()}"`}
                </s-button>
              )}
            </>
          ) : (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-text>{selectedSeller.name}</s-text>
                <s-button variant="tertiary" onClick={() => setSelectedSeller(null)}>
                  Trocar vendedor
                </s-button>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" justifyContent="space-between" gap="base">
            <s-heading>Cliente (Opcional)</s-heading>
            <s-button
              variant="tertiary"
              icon={isCustomerOpen ? "chevron-up" : "chevron-down"}
              accessibilityLabel={isCustomerOpen ? "Esconder cliente" : "Mostrar cliente"}
              onClick={() => setIsCustomerOpen((current) => !current)}
            />
          </s-stack>

          {isCustomerOpen && (!selectedCustomer ? (
            <>
              <s-text-field
                label="Buscar cliente"
                value={customerQuery}
                onInput={(event: any) => setCustomerQuery(event.target.value || "")}
              />

              {customerLoading && <s-paragraph>Buscando clientes…</s-paragraph>}
              {customerError && <s-banner tone="critical">{customerError}</s-banner>}

              {customerResults.length > 0 && (
                <s-stack direction="block" gap="base">
                  {customerResults.map((customer) => (
                    <s-box
                      key={customer.id}
                      padding="base"
                      borderWidth="base"
                      borderRadius="base"
                    >
                      <s-stack direction="block" gap="base">
                        <s-text>{customer.name}</s-text>
                        {customer.email && <s-text>{customer.email}</s-text>}
                        {customer.phone && <s-text>{customer.phone}</s-text>}
                        <s-button onClick={() => setSelectedCustomer(customer)}>
                          Selecionar
                        </s-button>
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              )}

              <s-section>
                <s-heading>Cliente novo</s-heading>
                <s-stack direction="block" gap="base">
                  <s-text-field
                    label="Nome"
                    value={newCustomer.firstName}
                    onInput={(event: any) =>
                      setNewCustomer((current) => ({
                        ...current,
                        firstName: event.target.value || "",
                      }))
                    }
                  />
                  <s-text-field
                    label="Sobrenome"
                    value={newCustomer.lastName}
                    onInput={(event: any) =>
                      setNewCustomer((current) => ({
                        ...current,
                        lastName: event.target.value || "",
                      }))
                    }
                  />
                  <s-text-field
                    label="E-mail"
                    value={newCustomer.email}
                    onInput={(event: any) =>
                      setNewCustomer((current) => ({
                        ...current,
                        email: event.target.value || "",
                      }))
                    }
                  />
                  <s-text-field
                    label="Telefone"
                    value={newCustomer.phone}
                    onInput={(event: any) =>
                      setNewCustomer((current) => ({
                        ...current,
                        phone: event.target.value || "",
                      }))
                    }
                  />
                  <s-button onClick={createCustomer}>Criar cliente</s-button>
                </s-stack>
              </s-section>
            </>
          ) : (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-text>{selectedCustomer.name}</s-text>
                {selectedCustomer.email && <s-text>{selectedCustomer.email}</s-text>}
                {selectedCustomer.phone && <s-text>{selectedCustomer.phone}</s-text>}
                <s-button variant="tertiary" onClick={() => setSelectedCustomer(null)}>
                  Trocar cliente
                </s-button>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-icon type="product" />
            <s-stack direction="block" gap="small">
              <s-heading>Produtos</s-heading>
              <s-paragraph color="subdued">
                Busque e adicione produtos ao pedido.
              </s-paragraph>
            </s-stack>
          </s-stack>

          <s-search-field
            label="Buscar produto"
            labelAccessibilityVisibility="exclusive"
            placeholder="Buscar produto"
            value={productQuery}
            onInput={(event: any) => setProductQuery(event.target.value || "")}
          />

          {productLoading && (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-spinner size="base" accessibilityLabel="Buscando produtos" />
              <s-paragraph>Buscando produtos…</s-paragraph>
            </s-stack>
          )}

          {!productLoading && productResults.length > 0 && (
            <>
              <s-query-container>
                <s-grid
                  gridTemplateColumns="@container (inline-size > 640px) 1fr 220px, 1fr"
                  gap="base"
                  alignItems="end"
                >
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text>{productResults.length} produtos encontrados para</s-text>
                    <s-text type="strong">“{productQuery.trim()}”</s-text>
                  </s-stack>
                  <s-select
                    label="Ordenar por"
                    value={productSort}
                    onChange={(event: any) => setProductSort(event.target.value as ProductSort)}
                  >
                    <s-option value="relevance">Mais relevantes</s-option>
                    <s-option value="price-asc">Menor preço</s-option>
                    <s-option value="price-desc">Maior preço</s-option>
                    <s-option value="title">Nome do produto</s-option>
                  </s-select>
                </s-grid>
              </s-query-container>

              <s-query-container>
                <s-grid
                  gridTemplateColumns="@container (inline-size > 900px) 1fr 1fr 1fr, 1fr"
                  gap="base"
                >
                  {sortedProductResults.map((product) => (
                    <s-grid-item key={product.id}>
                      <s-box padding="base" borderWidth="base" borderRadius="base">
                        <s-stack direction="block" gap="base">
                          <s-grid
                            gridTemplateColumns="112px minmax(0, 1fr)"
                            gap="base"
                            alignItems="start"
                          >
                            {product.image ? (
                              <img
                                src={product.image}
                                alt={product.productTitle}
                                loading="lazy"
                                style={{
                                  width: 112,
                                  height: 132,
                                  display: "block",
                                  objectFit: "cover",
                                  borderRadius: 8,
                                }}
                              />
                            ) : (
                              <div
                                aria-label="Produto sem imagem"
                                style={{
                                  width: 112,
                                  height: 132,
                                  display: "grid",
                                  placeItems: "center",
                                  borderRadius: 8,
                                  background: "var(--p-color-bg-surface-secondary, #f1f1f1)",
                                }}
                              >
                                <s-icon type="product" tone="neutral" />
                              </div>
                            )}

                            <s-stack direction="block" gap="base">
                              <s-text type="strong">{product.productTitle}</s-text>
                              <s-text color="subdued">{product.variantTitle}</s-text>
                              <s-text color="subdued">SKU: {product.sku || "—"}</s-text>
                              <s-text type="strong">{formatPrice(product.price)}</s-text>
                            </s-stack>
                          </s-grid>

                          <s-divider />
                          <s-button
                            variant="primary"
                            icon="cart"
                            onClick={() => addProduct(product)}
                          >
                            Adicionar
                          </s-button>
                        </s-stack>
                      </s-box>
                    </s-grid-item>
                  ))}
                </s-grid>
              </s-query-container>

              <s-stack direction="inline" justifyContent="center">
                <s-paragraph color="subdued">
                  Mostrando {sortedProductResults.length} de {productResults.length} produtos
                </s-paragraph>
              </s-stack>
            </>
          )}

          {!productLoading && productQuery.trim() && productResults.length === 0 && (
            <s-paragraph color="subdued">
              Nenhum produto encontrado para “{productQuery.trim()}”.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-heading>Produtos do pedido</s-heading>
          {orderItems.length === 0 ? (
            <s-paragraph>Nenhum produto adicionado.</s-paragraph>
          ) : (
            orderItems.map((item) => (
              <s-box key={item.localId} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    {item.image && <img src={item.image} alt={item.productTitle} style={{ maxWidth: 70, borderRadius: 8 }} />}
                    <s-stack direction="block" gap="base">
                      <s-text>{item.productTitle}</s-text>
                      <s-text>{item.variantTitle}</s-text>
                      <s-text>{item.sku || "SKU não informado"}</s-text>
                      <s-text-field
                        label="Valor unitário"
                        value={item.displayPrice}
                        onInput={(event: any) =>
                          setOrderItems((current) => current.map((currentItem) =>
                            currentItem.localId === item.localId
                              ? { ...currentItem, displayPrice: event.target.value || "0" }
                              : currentItem,
                          ))
                        }
                      />
                    </s-stack>
                  </s-stack>
                  <s-stack direction="inline" gap="base">
                    <s-button onClick={() => adjustQuantity(item.localId, -1)}>-</s-button>
                    <s-text>{item.quantity}</s-text>
                    <s-button onClick={() => adjustQuantity(item.localId, 1)}>+</s-button>
                    <s-button variant="tertiary" onClick={() => removeItem(item.localId)}>Remover</s-button>
                  </s-stack>
                  <s-heading>Personalização</s-heading>
                  {Array.from({ length: item.quantity }, (_, index) => (
                    <s-text-field
                      key={`${item.localId}-${index}`}
                      label={`Unidade ${index + 1}`}
                      value={item.engravings[index] || ""}
                      onInput={(event: any) => updateEngraving(item.localId, index, event.target.value || "")}
                    />
                  ))}
                </s-stack>
              </s-box>
            ))
          )}
        </s-stack>
      </s-section>

      <s-section>
        <s-heading>Observações (Opcional)</s-heading>
        <s-text-field
          value={note}
          onInput={(event: any) => setNote(event.target.value || "")}
        />
      </s-section>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-heading>Resumo do pedido</s-heading>
          <s-text>Cliente: {selectedCustomer ? selectedCustomer.name : "Guest checkout"}</s-text>
          <s-text>Vendedor: {selectedSeller?.name || "Não selecionado"}</s-text>
          <s-text>Subtotal dos produtos: {formatPrice(subtotal)}</s-text>
          <s-text>Frete: calculado no checkout</s-text>
          {error && <s-banner tone="critical">{error}</s-banner>}
          {success ? (
            <s-banner tone="success">
              Pedido criado com sucesso. <a href={success.invoiceUrl} target="_blank" rel="noreferrer">Abrir checkout</a>
            </s-banner>
          ) : null}
          <s-button disabled={!canCreateOrder} onClick={handleCreateDraftOrder}>
            {isCreating ? "Criando…" : "Criar pedido e gerar link de pagamento"}
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
