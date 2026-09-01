import supertest from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

export const api = supertest(app);

export const PASSWORD = "correct-horse-battery";

// Wipe every account-scoped table between tests. signing_keys is left alone -
// globalSetup created the one key the whole suite signs with.
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "refresh_tokens", "sessions", "identities", "users" RESTART IDENTITY CASCADE',
  );
}

let seq = 0;
export const uniqueEmail = (prefix = "user") => `${prefix}+${Date.now()}-${seq++}@example.test`;

/** Register through a portal. Returns the parsed JSON body + status. */
export async function register(body: Record<string, unknown>) {
  const res = await api.post("/auth/email/register").send(body);
  return { status: res.status, body: res.body };
}

/** Log in through a portal. Returns status, body and any Set-Cookie header. */
export async function login(body: Record<string, unknown>) {
  const res = await api.post("/auth/email/login").send(body);
  return { status: res.status, body: res.body, cookies: cookieHeader(res) };
}

/** Collapse a Set-Cookie response header into a single Cookie request header. */
export function cookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = (res.headers["set-cookie"] as string[] | undefined) ?? [];
  return raw.map((c) => c.split(";")[0]).join("; ");
}

/** Pull one cookie's value out of a Set-Cookie header array. */
export function readSetCookie(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = (res.headers["set-cookie"] as string[] | undefined) ?? [];
  const match = raw.find((c) => c.startsWith(`${name}=`));
  return match?.slice(name.length + 1).split(";")[0];
}

/** Register + (if needed) approve, then log in. Returns the access token. */
export async function activeUserAccessToken(opts: {
  clientId: string;
  role?: string;
  email?: string;
}): Promise<{ accessToken: string; userId: string; email: string }> {
  const email = opts.email ?? uniqueEmail(opts.role ?? "u");
  const reg = await register({ email, password: PASSWORD, clientId: opts.clientId, role: opts.role });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);

  if (reg.body.status === "PENDING") {
    await prisma.user.update({
      where: { id: reg.body.id },
      data: { status: "ACTIVE", approvedAt: new Date() },
    });
  }

  const li = await login({ email, password: PASSWORD, clientId: opts.clientId });
  if (li.status !== 200) throw new Error(`login failed: ${JSON.stringify(li.body)}`);
  return { accessToken: li.body.accessToken, userId: reg.body.id, email };
}
