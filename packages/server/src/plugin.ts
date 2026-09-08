import type { Context } from "@deepseek-ai/cordis";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import {
  Controller,
  type ControllerOptions,
} from "../../core/src/controller.js";
import { SdkRuntime, type RuntimeAdapter } from "../../runtime/src/adapter.js";
import { atomic } from "../../core/src/util.js";
import { startHttp } from "./http.js";
declare module "@deepseek-ai/cordis" {
  interface Context {
    worker: Controller;
  }
}
export const name = "dsh-worker-controller";
export interface PluginOptions extends Omit<ControllerOptions, "runtime"> {
  runtime?: RuntimeAdapter;
  port?: number;
  token?: string;
  webDir?: string;
  harnessHomes?: string[];
  onReady?: (url: string, controller: Controller) => void;
  onError?: (error: unknown) => void;
}
// The controller service and its transports share one reversible resource lifetime.
// JSON profile config can mount this plugin; runtime injection is optional for tests/embedders.
export function apply(ctx: Context, options: PluginOptions) {
  ctx.effect(async () => {
    const dist = import.meta.url.endsWith(".ts")
      ? resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist")
      : dirname(fileURLToPath(import.meta.url));
    let controller: Controller;
    try {
      controller = new Controller({
        ...options,
        runtime: options.runtime ?? new SdkRuntime(join(dist, "runner.js")),
      });
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
    const token = options.token ?? randomBytes(32).toString("hex");
    let http: Awaited<ReturnType<typeof startHttp>> | undefined;
    try {
      http = await startHttp(controller, {
        port: options.port ?? 4317,
        token,
        webDir: options.webDir ?? join(dist, "web"),
        harnessHomes: options.harnessHomes,
      });
      atomic(
        join(controller.home, "service.json"),
        JSON.stringify({ url: http.url, token, pid: process.pid }),
      );
    } catch (error) {
      await http?.close();
      await controller.close();
      options.onError?.(error);
      throw error;
    }
    const unprovide = ctx.provide("worker", controller);
    options.onReady?.(http.url, controller);
    return async () => {
      unprovide();
      await http!.close();
      await controller.close();
      if (existsSync(join(controller.home, "service.json")))
        unlinkSync(join(controller.home, "service.json"));
    };
  });
}
