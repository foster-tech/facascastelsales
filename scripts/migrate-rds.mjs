import { Signer } from "@aws-sdk/rds-signer";
import { spawnSync } from "node:child_process";

const hostname = process.env.RDS_HOST;
const database = process.env.RDS_DATABASE;
const username = process.env.RDS_USERNAME;
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const port = Number(process.env.RDS_PORT || "5432");

if (!hostname || !database || !username || !region || !Number.isInteger(port)) {
  throw new Error(
    "Configure RDS_HOST, RDS_DATABASE, RDS_USERNAME, AWS_REGION e RDS_PORT antes de executar migra\u00e7\u00f5es.",
  );
}

const signer = new Signer({ hostname, port, username, region });
const token = await signer.getAuthToken();
const connectionUrl = new URL(`postgresql://${encodeURIComponent(username)}@${hostname}:${port}/${database}`);
connectionUrl.password = token;
connectionUrl.searchParams.set("sslmode", "require");

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: connectionUrl.toString() },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
