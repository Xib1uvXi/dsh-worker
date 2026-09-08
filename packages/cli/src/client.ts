import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Action,
  Overview,
  TicketView,
  PruneResult,
} from "../../contracts/src/index.js";
import { ensure, hash } from "../../shared/src/util.js";
export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome?: "unknown",
  ) {
    super(message);
  }
}
export class WorkerClient {
  readonly url: string;
  readonly token: string;
  constructor(
    home: string,
    readonly timeoutMs = 10000,
  ) {
    let service: { url: string; token: string };
    try {
      service = JSON.parse(readFileSync(join(home, "service.json"), "utf8"));
    } catch (error) {
      throw new ClientError(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "service_missing"
          : "service_config",
        "Cannot read service discovery; check the control home and run health.",
      );
    }
    if (
      !service ||
      typeof service.url !== "string" ||
      typeof service.token !== "string" ||
      !service.token
    )
      throw new ClientError(
        "service_config",
        "Service discovery requires a URL and token; run health.",
      );
    let url: URL;
    try {
      url = new URL(service.url);
    } catch {
      throw new ClientError("service_url", "Invalid service URL; run health.");
    }
    ensure(
      url.hostname === "127.0.0.1" &&
        url.protocol === "http:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/",
      "service_url",
      "Worker service must be loopback HTTP",
    );
    this.url = url.origin;
    this.token = service.token;
  }
  async request<T>(path: string, action?: Action): Promise<T> {
    let response: Response;
    let result: T & { error?: { code?: string; message?: string } };
    try {
      response = await fetch(this.url + path, {
        method: action ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(action ? { "Content-Type": "application/json" } : {}),
        },
        body: action ? JSON.stringify(action) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      result = (await response.json()) as typeof result;
    } catch (error) {
      const code =
        (error as Error).name === "TimeoutError"
          ? "service_timeout"
          : error instanceof SyntaxError
            ? "service_response"
            : "service_unreachable";
      throw new ClientError(
        code,
        code === "service_timeout"
          ? "Service request timed out; inspect status before retrying."
          : code === "service_response"
            ? "Service returned an invalid JSON response."
            : "Cannot connect to the local service; run health.",
        action ? "unknown" : undefined,
      );
    }
    if (!response.ok)
      throw new ClientError(
        result?.error?.code ?? `http_${response.status}`,
        result?.error?.message ?? `HTTP ${response.status}`,
      );
    return result;
  }
  overview() {
    return this.request<Overview>("/api/overview");
  }
  async artifact(digest: string) {
    ensure(/^[a-f0-9]{64}$/.test(digest), "digest", "Expected artifact SHA256");
    const response = await fetch(this.url + `/api/artifacts/${digest}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    ensure(
      response.ok,
      "artifact",
      `Cannot read artifact: HTTP ${response.status}`,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    ensure(
      hash(bytes) === digest,
      "artifact_corrupt",
      "Artifact digest mismatch",
    );
    return bytes;
  }
  status(id: string, summary = false) {
    return this.request<TicketView>(
      `/api/tickets/${encodeURIComponent(id)}${summary ? "?summary=1" : ""}`,
    );
  }
  action(command: Extract<Action, { action: "prune" }>): Promise<PruneResult>;
  action(command: Exclude<Action, { action: "prune" }>): Promise<TicketView>;
  action(command: Action): Promise<TicketView | PruneResult>;
  action(command: Action) {
    return this.request<TicketView | PruneResult>("/api/actions", command);
  }
}
