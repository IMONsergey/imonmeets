import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { schema } from "../src/db.js";
import { createMedia } from "../src/media.js";
export const password = "Suite-password-strong-90123";
export function responseCookie(r: LightMyRequestResponse, previous = "") {
  const jar = new Map(
    previous
      .split("; ")
      .filter(Boolean)
      .map((v) => {
        const i = v.indexOf("=");
        return [v.slice(0, i), v.slice(i + 1)];
      }),
  );
  const values = r.headers["set-cookie"];
  for (const entry of (Array.isArray(values) ? values : [values]).filter(
    Boolean,
  )) {
    const first = String(entry).split(";")[0]!,
      i = first.indexOf("=");
    if (first.slice(i + 1)) jar.set(first.slice(0, i), first.slice(i + 1));
    else jar.delete(first.slice(0, i));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
export async function harness(
  env: Record<string, string> = {},
  paymentRequest?: typeof fetch,
  sendMail?: (to: string, subject: string, text: string) => Promise<void>,
) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
    ns = `im_suite_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${ns}"`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set("options", `-csearch_path=${ns}`);
  const c = loadConfig({
    DATABASE_URL: url.toString(),
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
    APP_URL: "http://localhost:5173",
    LIVEKIT_URL: "ws://localhost:7880",
    LIVEKIT_API_KEY: "suite-key",
    LIVEKIT_API_SECRET: "suite-secret-at-least-32-characters",
    ...env,
  });
  const pool = new Pool({ connectionString: url.toString() }),
    auth = createAuth(c, pool);
  await (await getMigrations(auth.options)).runMigrations();
  await pool.query(schema);
  const media = createMedia(c),
    retired: string[] = [],
    deleted: string[] = [];
  media.rooms.createRoom = async () =>
    ({}) as Awaited<ReturnType<typeof media.rooms.createRoom>>;
  media.rooms.listRooms = async () => [];
  media.rooms.listParticipants = async () => [];
  media.rooms.deleteRoom = async (name) => {
    retired.push(name);
  };
  media.delete = async (key) => {
    deleted.push(key);
  };
  media.egress.listEgress = async () => [];
  const app = await createApp(c, {
    pool,
    media,
    logger: false,
    paymentRequest,
    sendMail,
  });
  async function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method,
      url: path,
      headers: { origin: c.appUrl, ...(cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined
        ? { payload: body as InjectOptions["payload"] }
        : {}),
    });
  }
  async function signup(email: string) {
    const r = await request("POST", "/api/auth/sign-up/email", {
      name: email.split("@")[0],
      email,
      password,
    });
    assert.equal(r.statusCode, 200, r.body);
    await pool.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [
      email,
    ]);
    const cookie = responseCookie(r),
      me = (await request("GET", "/api/me", undefined, cookie)).json();
    return { cookie, id: me.user.id, email };
  }
  async function workspace(cookie: string, name = "Suite") {
    const r = await request("POST", "/api/workspaces", { name }, cookie);
    assert.equal(r.statusCode, 200, r.body);
    return r.json().workspace as { id: string };
  }
  async function room(
    cookie: string,
    w: string,
    body: Record<string, unknown> = {},
  ) {
    const r = await request(
      "POST",
      `/api/workspaces/${w}/rooms`,
      { title: "Suite meeting", ...body },
      cookie,
    );
    assert.equal(r.statusCode, 200, r.body);
    return r.json().room as { id: string; slug: string; waitingRoom: boolean };
  }
  async function close() {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA "${ns}" CASCADE`);
    await admin.end();
  }
  return {
    c,
    pool,
    app,
    media,
    retired,
    deleted,
    request,
    signup,
    workspace,
    room,
    close,
  };
}
