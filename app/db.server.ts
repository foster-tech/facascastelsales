import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("Configure DATABASE_URL com a conexão PostgreSQL provisionada pelo Vercel.");
}

const prismaAdapter = new PrismaPg({ connectionString });

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient({ adapter: prismaAdapter });
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient({ adapter: prismaAdapter });

export default prisma;
