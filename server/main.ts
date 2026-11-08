import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { brandFromEnv, createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { parseConfig, watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createKnowledgeBase } from "./kb.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.KNOWLEDGE_BASE_DB ?? "/data/knowledge-base.db";
const configPath = process.env.KNOWLEDGE_BASE_CONFIG?.trim() || "/config/knowledge-base.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const suggestFile = new URL("../dist/suggest/suggest.js", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.KNOWLEDGE_BASE_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.KNOWLEDGE_BASE_METRICS_PORT ? Number(process.env.KNOWLEDGE_BASE_METRICS_PORT) : undefined;

const db = openDb(dbPath);
// The address people open Knowledge Base at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects, the
// suggest script and, unless the file gives the help center its own address, the help center's links use it.
const publicUrl = (process.env.KNOWLEDGE_BASE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.KNOWLEDGE_BASE_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "knowledge-base",
  productName: "OpenAsy Knowledge Base",
  origin: publicUrl,
  // Locally the same product is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.KNOWLEDGE_BASE_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
let file: ReturnType<typeof watchConfig> | undefined;
const kb = createKnowledgeBase(db, { publicUrl, fileState: () => file?.state ?? null });
// The settings come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config, text) => kb.setConfig(config, text), {
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
// Without a file, the help center starts in English with no topics, so a first look needs nothing written.
if (!kb.config()) {
  kb.setConfig(parseConfig(""), "");
  log("warn", "no settings file applied: using the defaults until it can be read", { file: configPath });
}
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    kb,
    version,
    publicUrl,
    auth,
    accent: brandFromEnv(process.env).accent,
    suggestScript: existsSync(suggestFile) ? readFileSync(suggestFile, "utf8") : undefined,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(kb, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "knowledge base started", { version, port, db: dbPath, config: configPath, headless, help: kb.helpUrl() }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log(
    "warn",
    "KNOWLEDGE_BASE_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and https sites cannot load the script. Put it behind TLS (ADR 0026)",
    {
      url: publicUrl,
    },
  );
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

kb.purge();
const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(() => kb.purge(), 3_600_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
