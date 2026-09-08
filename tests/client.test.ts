import { expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerClient } from "../packages/cli/src/client.js";

it("bounds a hung HTTP request and marks a mutation timeout as an unknown outcome", async () => {
  const home = mkdtempSync(join(tmpdir(), "worker-client-"));
  let requests = 0;
  const server = createServer((_req, _res) => {
    requests++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  writeFileSync(
    join(home, "service.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token: "local-only",
    }),
  );
  try {
    const client = new WorkerClient(home, 100);
    await expect(
      client.action({ action: "run", ticketId: "ONE" }),
    ).rejects.toMatchObject({ code: "service_timeout", outcome: "unknown" });
    expect(requests).toBe(1);
    await expect(client.overview()).rejects.toMatchObject({
      code: "service_timeout",
      outcome: undefined,
    });
    expect(requests).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
it("distinguishes an unreachable service from malformed responses", async () => {
  const home = mkdtempSync(join(tmpdir(), "worker-client-"));
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("not-json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  writeFileSync(
    join(home, "service.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}/`,
      token: "local-only",
    }),
  );
  const client = new WorkerClient(home, 1000);
  try {
    await expect(client.overview()).rejects.toMatchObject({
      code: "service_response",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  try {
    await expect(client.overview()).rejects.toMatchObject({
      code: "service_unreachable",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
