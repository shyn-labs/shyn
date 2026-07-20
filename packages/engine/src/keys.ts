import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface KeyProvider { getKey(): string | null }

export class StaticKeyProvider implements KeyProvider {
  constructor(private key: string | null) {}
  getKey() { return this.key; }
}

const SERVICE = "shyn", ACCOUNT = "db-key";

export class KeychainKeyProvider implements KeyProvider {
  getKey(): string {
    try {
      return execFileSync("security",
        ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
        { encoding: "utf8" }).trim();
    } catch {
      const key = randomBytes(32).toString("hex");
      execFileSync("security",
        ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", key]);
      return key;
    }
  }
}
