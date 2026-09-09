import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginsSchema } from "../../contracts/src/index.js";
import type { PluginSelection } from "../../contracts/src/index.js";
import { atomic, ensure, hash } from "../../shared/src/util.js";

export function runtimeFile(name: string) {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? `../../../dist/${name}.js`
        : `./${name}.js`,
      import.meta.url,
    ),
  );
}
export function pluginSelection(home: string, override?: PluginSelection) {
  const path = join(home, "plugins.json");
  return pluginsSchema.parse(
    override ??
      (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}),
  );
}
export function pluginEnvRequired(config: PluginSelection) {
  return [
    ...new Set(
      config.mcp.flatMap((server) =>
        Object.values(
          server.transport === "stdio" ? server.env : server.headerEnv,
        ),
      ),
    ),
  ];
}
function commandPath(command: string, home: string) {
  const choices = command.includes("/")
    ? [resolve(home, command)]
    : (process.env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((p) => resolve(p, command));
  for (const choice of choices) {
    try {
      accessSync(choice, constants.X_OK);
      if (statSync(choice).isFile()) return choice;
    } catch {
      /* try next PATH entry */
    }
  }
  throw new Error(`Plugin command is not executable: ${command}`);
}
export function inspectPlugins(home: string, override?: PluginSelection) {
  const config = pluginSelection(home, override);
  const checks: { name: string; ok: boolean; error?: string }[] = [];
  const mcp = config.mcp.map((server) => {
    if (server.transport !== "stdio") return server;
    try {
      const command = commandPath(server.command, home);
      checks.push({ name: `mcp:${server.name}`, ok: true });
      return { ...server, command };
    } catch (error) {
      checks.push({
        name: `mcp:${server.name}`,
        ok: false,
        error: String(error),
      });
      return server;
    }
  });
  const hooks = config.hooks.map((hook) => {
    const configPath = resolve(home, hook.configPath);
    try {
      const content = readFileSync(configPath, "utf8");
      const document: unknown = JSON.parse(content);
      ensure(
        document &&
          typeof document === "object" &&
          !Array.isArray(document) &&
          "hooks" in document &&
          document.hooks &&
          typeof document.hooks === "object" &&
          !Array.isArray(document.hooks),
        "hook_config",
        "Expected a JSON object with a hooks object",
      );
      checks.push({ name: `hooks:${hook.kind}`, ok: true });
      return {
        ...hook,
        configPath: realpathSync(configPath),
        hash: hash(content),
      };
    } catch (error) {
      checks.push({
        name: `hooks:${hook.kind}`,
        ok: false,
        error: String(error),
      });
      return { ...hook, configPath, hash: "" };
    }
  });
  for (const name of pluginEnvRequired(config))
    checks.push({
      name: `env:${name}`,
      ok: Boolean(process.env[name]?.trim()),
      ...(!process.env[name]?.trim()
        ? {
            error: `Missing environment variable ${name}; include it in execution.envRequired`,
          }
        : {}),
    });
  return {
    ok: checks.every((c) => c.ok),
    config: { ...config, mcp, hooks },
    checks,
  };
}
export async function pluginsPatch(
  home: string,
  workspace: string,
  dir: string,
  override?: PluginSelection,
) {
  const report = inspectPlugins(home, override);
  atomic(join(dir, "plugins.json"), JSON.stringify(report));
  ensure(
    report.ok,
    "plugins_preflight",
    report.checks
      .filter((c) => !c.ok)
      .map((c) => c.error)
      .join("; "),
  );
  const hooks = report.config.hooks.map((hook) => {
    const content = readFileSync(hook.configPath, "utf8");
    ensure(
      hash(content) === hook.hash,
      "hook_changed",
      "Hook configuration changed during admission",
    );
    const configPath = join(dir, `hooks-${hook.kind}.json`);
    atomic(configPath, content);
    return { ...hook, configPath };
  });
  const patch = [
    { id: "subprocess", disabled: true },
    {
      id: "sdk-jsonrpc-server",
      inject: ["sdkAppStartup", "loader", "workerCapabilitiesReady"],
    },
    ...(report.config.ptc !== "off"
      ? [{ id: "tools", config: { mode: report.config.ptc } }]
      : []),
    {
      insert: [
        { id: "worker-subprocess", name: runtimeFile("owned-subprocess") },
        {
          id: "worker-capabilities",
          name: runtimeFile("capability-plugin"),
          config: {
            ...report.config,
            hooks,
            workspace: realpathSync(workspace),
            statsPath: join(dir, "stats.json"),
          },
        },
      ],
    },
  ];
  const path = join(dir, "plugins.patch.json");
  atomic(path, JSON.stringify(patch));
  return path;
}
