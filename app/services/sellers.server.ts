import db from "../db.server";

export type SellerResult = {
  id: string;
  name: string;
};

export const normalizeSellerName = (name: string) =>
  name.trim().toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");

export async function searchSellers(query: string): Promise<SellerResult[]> {
  const normalizedQuery = normalizeSellerName(query);

  if (!normalizedQuery) {
    return [];
  }

  return db.seller.findMany({
    where: {
      active: true,
      normalizedName: { contains: normalizedQuery },
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 10,
  });
}

export async function createOrGetSeller(name: string): Promise<SellerResult> {
  const normalizedName = normalizeSellerName(name);

  if (!normalizedName) {
    throw new Error("Informe o nome do vendedor.");
  }

  const existingSeller = await db.seller.findUnique({
    where: { normalizedName },
    select: { id: true, name: true },
  });

  if (existingSeller) {
    return existingSeller;
  }

  try {
    return await db.seller.create({
      data: {
        name: name.trim().replace(/\s+/g, " "),
        normalizedName,
      },
      select: { id: true, name: true },
    });
  } catch (error) {
    const sellerCreatedByAnotherRequest = await db.seller.findUnique({
      where: { normalizedName },
      select: { id: true, name: true },
    });

    if (sellerCreatedByAnotherRequest) {
      return sellerCreatedByAnotherRequest;
    }

    throw error;
  }
}

export async function getActiveSeller(id: string): Promise<SellerResult> {
  const seller = await db.seller.findFirst({
    where: { id, active: true },
    select: { id: true, name: true },
  });

  if (!seller) {
    throw new Error("Selecione um vendedor ativo.");
  }

  return seller;
}