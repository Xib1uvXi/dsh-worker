import { expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serviceToken } from "../packages/shared/src/service-token.js";

it("retains a private per-home token across clean shutdown and uses different identities for different homes", () => {
  const home = mkdtempSync(join(tmpdir(), "worker-auth-"));
  const token = serviceToken(home);
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(join(home, "service.json"), JSON.stringify({ token }));
  unlinkSync(join(home, "service.json"));
  expect(serviceToken(home)).toBe(token);
  expect(statSync(join(home, "service-token")).mode & 0o777).toBe(0o600);
  expect(serviceToken(mkdtempSync(join(tmpdir(), "worker-auth-")))).not.toBe(
    token,
  );
});
it("adopts an existing issued token and never silently replaces corrupt durable credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "worker-auth-"));
  writeFileSync(
    join(home, "service.json"),
    JSON.stringify({ token: "c".repeat(64) }),
  );
  expect(serviceToken(home)).toBe("c".repeat(64));
  writeFileSync(join(home, "service-token"), "broken");
  expect(() => serviceToken(home)).toThrow(/Invalid saved service token/);
  expect(readFileSync(join(home, "service-token"), "utf8")).toBe("broken");
});
