import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  existsSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Controller } from "../../core/src/controller.js";
import { WorkerError, ensure, hash } from "../../core/src/util.js";
import { sessions } from "./observer.js";
import { trajectory } from "./trajectory.js";

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  let data = "";
  for await (const chunk of req) {
    data += String(chunk);
    ensure(
      Buffer.byteLength(data) <= 1024 * 1024,
      "body_size",
      "Request exceeds 1 MiB",
    );
  }
  try {
    return JSON.parse(data);
  } catch {
    throw new WorkerError("invalid_json", "Request body is not valid JSON");
  }
}
export async function startHttp(
  controller: Controller,
  options: {
    port: number;
    token: string;
    webDir: string;
    harnessHomes?: string[];
  },
) {
  const streams = new Set<ServerResponse>();
  let base = "";
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      ensure(
        req.headers.host === new URL(base).host,
        "host",
        "Unexpected Host header",
      );
      const url = new URL(req.url ?? "/", base);
      if (url.pathname.startsWith("/api/")) {
        const provided =
          req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const valid =
          Buffer.byteLength(provided) === Buffer.byteLength(options.token) &&
          timingSafeEqual(Buffer.from(provided), Buffer.from(options.token));
        ensure(valid, "unauthorized", "Valid local service token required");
        ensure(
          !req.headers.origin || req.headers.origin === base,
          "origin",
          "Cross-origin request refused",
        );
        const blob = url.pathname.match(/^\/api\/artifacts\/([a-f0-9]{64})$/);
        if (req.method === "GET" && blob) {
          const path = join(controller.home, "artifacts", "blobs", blob[1]!);
          ensure(existsSync(path), "not_found", "Artifact not found");
          const bytes = readFileSync(path);
          ensure(
            hash(bytes) === blob[1],
            "artifact_corrupt",
            "Artifact content no longer matches its digest",
          );
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
          });
          res.end(bytes);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/overview")
          return json(res, controller.overview());
        if (req.method === "GET" && url.pathname === "/api/sessions")
          return json(res, await sessions(options.harnessHomes ?? []));
        if (req.method === "GET" && url.pathname === "/api/events") {
          let cursor = Number(
            url.searchParams.get("after") ?? req.headers["last-event-id"] ?? 0,
          );
          ensure(
            Number.isSafeInteger(cursor) && cursor >= 0,
            "cursor",
            "Invalid journal cursor",
          );
          if (req.headers.accept !== "text/event-stream")
            return json(res, controller.store.events(cursor));
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          streams.add(res);
          const flush = () => {
            for (const event of controller.store.events(cursor)) {
              if (res.writableLength > 1024 * 1024) {
                res.destroy();
                return;
              }
              res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
              cursor = event.seq;
            }
          };
          flush();
          const timer = setInterval(flush, 500);
          req.on("close", () => {
            clearInterval(timer);
            streams.delete(res);
          });
          return;
        }
        const timeline = url.pathname.match(
          /^\/api\/tickets\/([^/]+)\/(trajectory|activity)$/,
        );
        if (req.method === "GET" && timeline) {
          const after = Number(url.searchParams.get("after") ?? 0);
          ensure(
            Number.isSafeInteger(after) && after >= 0,
            "cursor",
            "Invalid trajectory cursor",
          );
          return json(
            res,
            trajectory(
              controller.store,
              decodeURIComponent(timeline[1]!),
              after,
              timeline[2] === "activity",
            ),
          );
        }
        const match = url.pathname.match(
          /^\/api\/tickets\/([^/]+)(\/recovery)?$/,
        );
        if (req.method === "GET" && match) {
          const id = decodeURIComponent(match[1]!);
          return json(
            res,
            match[2] ? controller.recovery(id) : controller.status(id),
          );
        }
        if (req.method === "POST" && url.pathname === "/api/actions") {
          ensure(
            req.headers["content-type"]?.startsWith("application/json"),
            "content_type",
            "Use application/json",
          );
          return json(res, await controller.action(await body(req)));
        }
        throw new WorkerError("not_found", "Unknown API route");
      }
      ensure(
        req.method === "GET" || req.method === "HEAD",
        "method",
        "Method not allowed",
      );
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
      };
      const asset = assets[url.pathname];
      ensure(asset, "not_found", "Not found");
      const path = join(options.webDir, asset[0]);
      ensure(existsSync(path), "not_found", "Build the web assets first");
      res.writeHead(200, { "Content-Type": asset[1] });
      res.end(req.method === "HEAD" ? undefined : readFileSync(path));
    })().catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const code =
        error instanceof WorkerError
          ? error.code
          : error instanceof z.ZodError
            ? "invalid_contract"
            : "internal";
      const status =
        code === "unauthorized"
          ? 401
          : code === "not_found"
            ? 404
            : code === "host" || code === "origin"
              ? 403
              : code === "internal"
                ? 500
                : 400;
      json(
        res,
        {
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
          },
        },
        status,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  ensure(address && typeof address === "object", "listen", "No server address");
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
