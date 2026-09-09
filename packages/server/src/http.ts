import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Controller } from "../../core/src/controller.js";
import { WorkerError, ensure, hash } from "../../shared/src/util.js";
import { sessions } from "./observer.js";
import { trajectory } from "./trajectory.js";
import {
  evidenceQuerySchema,
  briefIdsSchema,
  type BatchBrief,
} from "../../contracts/src/index.js";
import { evidenceBrief } from "../../core/src/evidence.js";

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.length;
    ensure(size <= 1024 * 1024, "body_size", "Request exceeds 1 MiB");
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
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
  ensure(
    typeof options.token === "string" && options.token.trim().length > 0,
    "service_token",
    "A non-empty service token is required",
  );
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
          return json(res, await controller.pollOverview());
        if (req.method === "GET" && url.pathname === "/api/briefs") {
          ensure(
            [...url.searchParams.keys()].every((key) => key === "ticket"),
            "arguments",
            "Only ticket ids are supported for batch briefs",
          );
          const ids = briefIdsSchema.parse(url.searchParams.getAll("ticket"));
          const results = await Promise.allSettled(
            ids.map(async (id) =>
              evidenceBrief(await controller.pollStatus(id)),
            ),
          );
          const batch: BatchBrief = { briefs: [], errors: [] };
          results.forEach((result, index) => {
            if (result.status === "fulfilled") batch.briefs.push(result.value);
            else
              batch.errors.push({
                ticketId: ids[index]!,
                code:
                  result.reason instanceof WorkerError
                    ? result.reason.code
                    : "internal",
                message:
                  result.reason instanceof Error
                    ? result.reason.message
                    : "Cannot read task evidence",
              });
          });
          return json(res, batch);
        }
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
          /^\/api\/tickets\/([^/]+)\/(trajectory|activity|events|brief)$/,
        );
        if (req.method === "GET" && timeline) {
          const ticketId = decodeURIComponent(timeline[1]!);
          const allowed =
            timeline[2] === "brief"
              ? []
              : timeline[2] === "activity"
                ? ["attempt"]
                : timeline[2] === "events"
                  ? ["after", "limit"]
                  : ["after", "limit", "attempt", "kind"];
          ensure(
            [...url.searchParams.keys()].every((key) => allowed.includes(key)),
            "arguments",
            "Unsupported evidence query option",
          );
          const query = evidenceQuerySchema.parse({
            after: Number(url.searchParams.get("after") ?? 0),
            limit: Number(url.searchParams.get("limit") ?? 100),
            attempt: url.searchParams.get("attempt") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
          });
          if (timeline[2] === "brief")
            return json(
              res,
              evidenceBrief(await controller.pollStatus(ticketId)),
            );
          if (timeline[2] === "events") {
            ensure(
              !query.attempt && !query.kind,
              "arguments",
              "Control events support after and limit only",
            );
            controller.store.get(ticketId, false);
            const rows = controller.store.controlEvents(
              query.after,
              query.limit + 1,
              ticketId,
            );
            const entries = rows.slice(0, query.limit);
            return json(res, {
              entries,
              cursor: entries.at(-1)?.seq ?? query.after,
              hasMore: rows.length > query.limit,
            });
          }
          return json(
            res,
            trajectory(
              controller.store,
              ticketId,
              query.after,
              timeline[2] === "activity",
              query,
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
            match[2]
              ? controller.recovery(id)
              : await controller.pollStatus(
                  id,
                  url.searchParams.get("summary") !== "1",
                ),
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
