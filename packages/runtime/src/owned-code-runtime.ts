import CodeRuntime from "@deepseek-ai/dsh-code-runtime-worker-thread";
import type { CodeRunRequest } from "@deepseek-ai/dsh-code-runtime";
import { runtimeFile } from "./plugins.js";
import { pathToFileURL } from "node:url";

export default class OwnedCodeRuntime extends CodeRuntime {
  override run(request: CodeRunRequest) {
    const bootstrap = pathToFileURL(runtimeFile("ptc-bootstrap")).href;
    const program = `await (await import(${JSON.stringify(bootstrap)})).installProcessPolicy();\n${request.program}`;
    return super.run({ ...request, program });
  }
}
