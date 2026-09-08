import { existsSync, readFileSync, chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { atomic, ensure } from "./util.js";

// Called while the service owns its home lock. A restart is not a logout.
export function serviceToken(home: string): string {
  const path = join(home, "service-token");
  if (existsSync(path)) {
    ensure(
      lstatSync(path).isFile(),
      "service_token",
      "Service token must be a regular file",
    );
    const token = readFileSync(path, "utf8").trim();
    ensure(
      /^[a-f0-9]{64}$/.test(token),
      "service_token",
      "Invalid saved service token; restore it or remove the file to issue a new token",
    );
    chmodSync(path, 0o600);
    return token;
  }
  // Adopt the last announced token during upgrades when its discovery file exists.
  let token: string | undefined;
  const discovery = join(home, "service.json");
  if (existsSync(discovery)) {
    try {
      const previous = JSON.parse(readFileSync(discovery, "utf8")) as {
        token?: unknown;
      };
      if (
        typeof previous.token === "string" &&
        /^[a-f0-9]{64}$/.test(previous.token)
      )
        token = previous.token;
    } catch {
      /* A stale discovery file does not contain durable control state. */
    }
  }
  token ??= randomBytes(32).toString("hex");
  atomic(path, token + "\n");
  return token;
}
