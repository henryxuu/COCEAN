import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export class CredentialVault {
  private constructor(private readonly key: Buffer) {}

  static async load(path: string): Promise<CredentialVault> {
    let key: Buffer;
    try {
      key = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(dirname(path), { recursive: true });
      key = randomBytes(32);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${key.toString("base64url")}\n`, "utf8");
      } finally {
        await handle.close();
      }
    }
    if (key.length !== 32)
      throw new Error("COCEAN credential key must decode to 32 bytes");
    return new CredentialVault(key);
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      v: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      data: encrypted.toString("base64url"),
    };
    return JSON.stringify(envelope);
  }

  decrypt(value: string): string {
    const envelope = JSON.parse(value) as Envelope;
    if (envelope.v !== 1) throw new Error("Unsupported credential envelope");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
