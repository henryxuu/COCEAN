import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuthSession, AuthUser } from "@cocean/contracts";
import type { CoceanDatabase } from "@cocean/database";

const SESSION_COOKIE = "cocean_session";

export async function bootstrapOwner(
  database: CoceanDatabase,
  filePath: string | null,
  production: boolean,
): Promise<void> {
  if (database.countUsers() > 0) return;
  if (!filePath) {
    if (production)
      throw new Error(
        "COCEAN owner bootstrap secret is required until the first account exists",
      );
    return;
  }
  const source = await readFile(filePath, "utf8");
  const credential = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (credential.includes("\n") || credential.includes("\r"))
    throw new Error("COCEAN owner bootstrap secret must contain one line");
  const separator = credential.indexOf(":");
  const username = separator < 0 ? "" : credential.slice(0, separator);
  const password = separator < 0 ? "" : credential.slice(separator + 1);
  assertUsername(username);
  assertPassword(password);
  const now = new Date().toISOString();
  database.createUser(
    {
      id: randomUUID(),
      username,
      displayName: username,
      role: "ADMIN",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    },
    await hashPassword(password),
  );
}

export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    "16384",
    "8",
    "1",
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltText, hashText] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !nText ||
    !rText ||
    !pText ||
    !saltText ||
    !hashText
  )
    return false;
  const expected = Buffer.from(hashText, "base64url");
  if (expected.length !== 32) return false;
  try {
    const actual = await deriveKey(
      password,
      Buffer.from(saltText, "base64url"),
      expected.length,
      {
        N: Number(nText),
        r: Number(rText),
        p: Number(pText),
        maxmem: 64 * 1024 * 1024,
      },
    );
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

function deriveKey(
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function createSession(
  database: CoceanDatabase,
  user: AuthUser,
  ttlHours: number,
): { session: AuthSession; token: string } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
  database.createSession({
    id: randomUUID(),
    userId: user.id,
    tokenHash: tokenHash(token),
    expiresAt,
  });
  return { session: { user, expiresAt }, token };
}

export function readSession(
  database: CoceanDatabase,
  cookieHeader: string | undefined,
): AuthSession | null {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  return token ? database.getSessionByTokenHash(tokenHash(token)) : null;
}

export function deleteSession(
  database: CoceanDatabase,
  cookieHeader: string | undefined,
): void {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) database.deleteSessionByTokenHash(tokenHash(token));
}

export function sessionCookie(
  token: string,
  expiresAt: string,
  secure: boolean,
): string {
  const maxAge = Math.max(
    0,
    Math.floor((Date.parse(expiresAt) - Date.now()) / 1000),
  );
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function expiredSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function assertUsername(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value))
    throw new Error("账号只能使用 1–64 位字母、数字、点、下划线或短横线");
}

export function assertPassword(value: string): void {
  if (value.length < 10 || value.length > 256)
    throw new Error("密码长度必须为 10–256 个字符");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (name) result[name] = cookieValue;
  }
  return result;
}
