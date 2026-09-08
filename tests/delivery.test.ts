import { expect, it } from "vitest";
import { deliveryDocument } from "../packages/runtime/src/delivery.js";
import { deliverySchema } from "../packages/contracts/src/index.js";

const doc = {
  schemaVersion: 2,
  ticketId: "LIVE-01",
  revision: 1,
  attemptId: "attempt-01",
  outcome: "submitted",
  summary: "Implemented and tested",
  evidence: [{ acceptanceId: "AC1", evidence: "18 tests passed" }],
  commands: [{ command: "npm test", result: "18 passed; exit 0" }],
  notRun: [],
  blockers: [],
};
it("reads one strict delivery document from real-model prose or Markdown wrappers", () => {
  for (const text of [
    JSON.stringify(doc),
    "All 18 tests pass.\n\n" + JSON.stringify(doc),
    "Completed.\n```json\n" + JSON.stringify(doc) + "\n```",
  ])
    expect(deliverySchema.parse(deliveryDocument(text))).toEqual(doc);
});
it("rejects multiple documents, malformed output, trailing prose and missing fences", () => {
  for (const text of [
    "No delivery",
    "{}\n" + JSON.stringify(doc),
    "[]\n" + JSON.stringify(doc),
    "null\n" + JSON.stringify(doc),
    "null true\n" + JSON.stringify(doc),
    "Results:\n[\n]\n" + JSON.stringify(doc),
    '"another document"\n' + JSON.stringify(doc),
    "Narrative {example}\n" + JSON.stringify(doc),
    JSON.stringify(doc) + "\nDone",
    "```json\n" + JSON.stringify(doc),
    "{",
  ])
    expect(() => deliveryDocument(text)).toThrow();
});
it("does not make model prose or extra fields into acceptable delivery evidence", () => {
  expect(() => deliverySchema.parse(deliveryDocument("Done.\n{}"))).toThrow();
  expect(() =>
    deliverySchema.parse(
      deliveryDocument(
        JSON.stringify({
          ...doc,
          commands: [{ command: "npm test", result: "passed", exitCode: 0 }],
        }),
      ),
    ),
  ).toThrow();
});
it("allows numbered progress and Markdown task/link prose before the single delivery", () => {
  for (const prefix of [
    "1. Added tests\n2. Fixed implementation",
    "18 tests passed",
    "- [x] Tests pass",
    "See [changes](https://example.com).",
    "Tests [18/18] passed",
  ])
    expect(deliveryDocument(prefix + "\n" + JSON.stringify(doc))).toEqual(doc);
});
