import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Signer } from "@aws-sdk/rds-signer";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

const rdsHost = process.env.RDS_HOST;
const rdsDatabase = process.env.RDS_DATABASE;
const rdsUsername = process.env.RDS_USERNAME;
const rdsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const rdsPort = Number(process.env.RDS_PORT || "5432");

if (!rdsHost || !rdsDatabase || !rdsUsername || !rdsRegion || !Number.isInteger(rdsPort)) {
  throw new Error(
    "Configure RDS_HOST, RDS_DATABASE, RDS_USERNAME, AWS_REGION e RDS_PORT para conectar ao PostgreSQL no RDS.",
  );
}

const rdsSigner = new Signer({
  hostname: rdsHost,
  port: rdsPort,
  username: rdsUsername,
  region: rdsRegion,
});

const prismaAdapter = new PrismaPg({
  host: rdsHost,
  port: rdsPort,
  database: rdsDatabase,
  user: rdsUsername,
  ssl: { rejectUnauthorized: true },
  password: () => rdsSigner.getAuthToken(),
});

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient({ adapter: prismaAdapter });
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient({ adapter: prismaAdapter });

export default prisma;
