import argon2 from "argon2";
import type { PasswordHasher } from "./auth.js";

/** Argon2id is deliberately kept behind the small server-side hasher seam. */
export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    try {
      return await argon2.verify(encodedHash, password);
    } catch {
      return false;
    }
  }
}
