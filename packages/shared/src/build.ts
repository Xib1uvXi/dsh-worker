import type { BuildInfo } from "../../contracts/src/index.js";
declare const __WORKER_BUILD__: BuildInfo;
// Source execution has no immutable build identity; never infer one from the
// current checkout after a service has started.
export const buildInfo: BuildInfo =
  typeof __WORKER_BUILD__ === "undefined"
    ? {
        version: "development",
        commit: null,
        sourceDigest: null,
        builtAt: null,
      }
    : __WORKER_BUILD__;
