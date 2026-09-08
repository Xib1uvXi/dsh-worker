import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workflow } from "../packages/runtime/src/policy.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "worker-workflow-"));
  homes.push(home);
  const skill = join(home, "methods", "implement");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: implement\ndescription: Implement assigned changes\n---\nUse behavioral tests.\n",
  );
  writeFileSync(join(home, "instructions.md"), "Preserve inherited work.");
  const config = {
    schemaVersion: 2,
    skillDirs: ["methods/implement"],
    instructionFiles: ["instructions.md"],
    entrySkills: ["implement"],
  };
  const save = () =>
    writeFileSync(join(home, "workflow.json"), JSON.stringify(config));
  save();
  return { home, skill, config, save };
}
it("resolves portable per-home configuration and exposes named skills and explicit entry instructions", () => {
  const s = setup();
  const result = workflow(s.home, s.home);
  expect(result.skills.map((s) => s.name)).toEqual(["implement"]);
  expect(result.entrySkills).toEqual(["implement"]);
  expect(result.context).toContain("Preserve inherited work.");
  expect(result.context).toContain(
    "Load these entry skills before implementation: implement",
  );
  expect(result.context).toContain("external orchestrator");
  expect(result.evidence).toHaveLength(2);
  const patch = JSON.parse(readFileSync(result.patch!, "utf8"));
  expect(patch[0].config.customSkillDirs).toEqual([
    result.skills[0]!.path.replace(/\/SKILL.md$/, ""),
  ]);
  expect(patch[0].config.includeDefaultRoots).toBe(false);
  const other = setup();
  other.config.entrySkills = [];
  other.save();
  expect(workflow(other.home).entrySkills).toEqual([]);
});
it("rejects ambiguous names and unresolved entry skills before dispatch", () => {
  const s = setup();
  s.config.skillDirs.push("methods/implement");
  s.save();
  expect(() => workflow(s.home)).toThrow(/unique names/);
  s.config.skillDirs.pop();
  s.config.entrySkills = ["missing"];
  s.save();
  expect(() => workflow(s.home)).toThrow(/Entry skill not found/);
});
it("rejects metadata that Harness would omit from its skill catalog", () => {
  const s = setup();
  writeFileSync(join(s.skill, "SKILL.md"), "---\nname: implement\n---\nBody");
  expect(() => workflow(s.home)).toThrow(/description/);
  writeFileSync(
    join(s.skill, "SKILL.md"),
    "---\nname: Invalid Name\ndescription: Body\n---\nBody",
  );
  expect(() => workflow(s.home)).toThrow(/invalid skill name/);
});
