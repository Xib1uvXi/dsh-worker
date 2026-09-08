import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { workflowSchema } from "../../contracts/src/index.js";
import { atomic, ensure, hash } from "../../shared/src/util.js";

export const workerPolicy = [
  { id: "approval", config: { policy: "never" } },
  {
    id: "permission",
    config: {
      defaultPreset: "workspace-write",
      presets: {
        "workspace-write": { sandbox: "workspace-write", approval: "never" },
      },
    },
  },
  { id: "sdk-jsonrpc-server", config: { maxTokensAsSuccess: false } },
  ...[
    "tool-subagent",
    "tool-subagent-fork",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-workflow",
  ].map((id) => ({ id, disabled: true })),
];
export const workerRole = `You are the implementation worker. The external orchestrator owns design, scheduling, review, acceptance and integration. Implement and test only the assigned scope. Preserve inherited work. Do not commit, merge, push, publish, delegate, or self-accept. Return missing decisions and permission blockers in the delivery. Use repository instructions and configured skills for engineering methods within this role. Tool success and your final text do not constitute acceptance.`;
function expand(path: string, base: string) {
  return path.startsWith("~/")
    ? join(homedir(), path.slice(2))
    : resolve(base, path);
}
export function workflow(home: string, runDir?: string) {
  const file = process.env.DSH_WORKER_WORKFLOW ?? join(home, "workflow.json");
  if (!existsSync(file)) {
    ensure(
      !process.env.DSH_WORKER_WORKFLOW,
      "workflow_missing",
      "Explicit workflow configuration is missing",
    );
    return {
      configPath: undefined,
      skills: [] as { name: string; path: string; hash: string }[],
      entrySkills: [] as string[],
      patch: undefined,
      context: "",
      evidence: [] as { path: string; hash: string }[],
    };
  }
  const conf = workflowSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const configPath = realpathSync(file);
  const base = dirname(configPath);
  const dirs = conf.skillDirs.map((p) => realpathSync(expand(p, base)));
  const skills = dirs.map((p) => {
    const content = readFileSync(join(p, "SKILL.md"), "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    ensure(match, "skill_metadata", `Missing skill frontmatter: ${p}`);
    const meta = YAML.parse(match[1]!) as {
      name?: unknown;
      description?: unknown;
    } | null;
    ensure(
      typeof meta?.name === "string" &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name),
      "skill_metadata",
      `Missing or invalid skill name: ${p}`,
    );
    ensure(
      typeof meta.description === "string" && meta.description.trim(),
      "skill_metadata",
      `Missing skill description: ${p}`,
    );
    return { name: meta.name, path: join(p, "SKILL.md"), hash: hash(content) };
  });
  ensure(
    new Set(skills.map((s) => s.name)).size === skills.length,
    "skill_duplicate",
    "Configured skills must have unique names",
  );
  for (const entry of conf.entrySkills)
    ensure(
      skills.some((s) => s.name === entry),
      "skill_missing",
      `Entry skill not found: ${entry}`,
    );
  const instructions = conf.instructionFiles.map((p) => {
    const path = realpathSync(expand(p, base));
    const content = readFileSync(path, "utf8");
    return { path, content, hash: hash(content) };
  });
  const patch = dirs.length
    ? [
        {
          id: "skill-filesystem",
          disabled: false,
          config: {
            customSkillDirs: dirs,
            includeDefaultRoots: false,
            watch: false,
          },
        },
        { id: "tool-skill", disabled: false },
      ]
    : [];
  if (runDir && patch.length)
    atomic(join(runDir, "workflow.patch.json"), JSON.stringify(patch));
  return {
    configPath,
    skills,
    entrySkills: conf.entrySkills,
    patch:
      patch.length && runDir ? join(runDir, "workflow.patch.json") : undefined,
    context:
      instructions
        .map((i) => `Instructions from ${i.path}:\n${i.content}`)
        .join("\n\n") +
      (conf.entrySkills.length
        ? `\nLoad these entry skills before implementation: ${conf.entrySkills.join(", ")}. Apply their engineering methods within the implementation-worker role above; return review and acceptance to the external orchestrator.`
        : ""),
    evidence: [
      ...skills.map(({ path, hash }) => ({ path, hash })),
      ...instructions.map(({ path, hash }) => ({ path, hash })),
    ],
  };
}
export function policyPatch(dir: string) {
  const path = join(dir, "worker.patch.json");
  atomic(path, JSON.stringify(workerPolicy));
  return path;
}
