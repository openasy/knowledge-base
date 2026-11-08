// Starts the app on a random port for tests.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createKnowledgeBase } from "./kb.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const SITE = "https://www.shop.example";
export const READER_KEY = "reader-key-0123456789-0123456789-abcdef";

/** The settings file the tests start with. */
export const SETTINGS = `
site:
  name: Acme Help
  languages: [tr, en]
  default_language: tr
topics:
  - Getting started
  - { name: Account and sign-in, slug: account, names: { tr: Hesap ve giriş } }
  - { name: Invoices and e-Fatura, slug: invoices }
review:
  required: true
helpful:
  list_below: 60%
  min_answers: 2
plans:
  business: { name: Business plan }
readers:
  key: KB_READER_KEY
suggest:
  in: [helpdesk-form, live-chat]
  sites: [${SITE}]
`;

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse("2026-11-02T12:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms) });
}

export async function startApp(opts: Partial<AppOptions> & { version: string; settings?: string }) {
  const db = openDb(":memory:");
  const { settings = SETTINGS, ...rest } = opts;
  const clock = fakeClock();
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "knowledge-base", productName: "OpenAsy Knowledge Base", origin: base });
  const kb = createKnowledgeBase(db, { publicUrl: base, env: { KB_READER_KEY: READER_KEY }, clock });
  kb.setConfig(parseConfig(settings), settings);
  handler = createApp({ db, kb, auth, adminToken: ADMIN_TOKEN, publicUrl: base, suggestScript: "var OAKB={start:function(){}};", ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, kb, auth, base, admin, clock, close };
}
