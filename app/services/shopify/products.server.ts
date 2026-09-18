import { authenticate } from "../../shopify.server";

export type ProductVariantOption = {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku?: string | null;
  price: string;
  image?: string | null;
};

export async function searchProducts(
  request: Request,
  query: string,
): Promise<ProductVariantOption[]> {
  const { admin } = await authenticate.admin(request);
  const normalized = query.trim();

  const response = await admin.graphql(
    `#graphql
      query SearchProducts($query: String) {
        products(first: 12, query: $query) {
          nodes {
            id
            title
            featuredImage {
              url
            }
            variants(first: 20) {
              nodes {
                id
                title
                sku
                price
                availableForSale
              }
            }
          }
        }
      }`,
    {
      variables: {
        query: normalized || null,
      },
    },
  );

  const payload = await response.json();
  const products = payload?.data?.products?.nodes ?? [];

  const results: ProductVariantOption[] = [];

  for (const product of products) {
    for (const variant of product.variants?.nodes ?? []) {
      if (!variant?.id) {
        continue;
      }

      results.push({
        id: variant.id,
        productTitle: product.title,
        variantTitle: variant.title || "Padrão",
        sku: variant.sku,
        price: variant.price || "0.00",
        image: product.featuredImage?.url,
      });
    }
  }

  return results;
}
