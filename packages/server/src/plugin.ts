import type { Context } from "@deepseek-ai/cordis";
import { serviceToken } from "../../shared/src/service-token.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import {
  Controller,
  type ControllerOptions,
} from "../../core/src/controller.js";
import { SdkRuntime, type RuntimeAdapter } from "../../runtime/src/adapter.js";
import { atomic } from "../../shared/src/util.js";
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
  onReady?: (url: string, controller: Controller, token: string) => void;
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
    let token: string;
    let unprovide: (() => void) | undefined;
    let announced = false;
    let http: Awaited<ReturnType<typeof startHttp>> | undefined;
    const dispose = async () => {
      try {
        unprovide?.();
      } finally {
        try {
          await http?.close();
        } finally {
          try {
            if (announced && existsSync(join(controller.home, "service.json")))
              unlinkSync(join(controller.home, "service.json"));
          } finally {
            await controller.close();
          }
        }
      }
    };
    try {
      token = options.token ?? serviceToken(controller.home);
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
      announced = true;
      unprovide = ctx.provide("worker", controller);
      options.onReady?.(http.url, controller, token);
      return dispose;
    } catch (error) {
      let failure = error;
      try {
        await dispose();
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          "Service startup and cleanup failed",
        );
      }
      options.onError?.(failure);
      throw failure;
    }
  });
}
