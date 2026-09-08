import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";
if (process.argv[2])
  writeFileSync(
    process.argv[2],
    JSON.stringify({
      pid: process.pid,
      marker: process.env.DSH_WORKER_PROCESS_TOKEN,
    }),
  );
const server = new Server(
  { name: "worker-test", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo",
      description: "Deterministic local integration fixture",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "fail",
      description: "Explicit failure fixture",
      inputSchema: { type: "object" },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, (request) => ({
  isError: request.params.name === "fail",
  content: [
    {
      type: "text",
      text:
        request.params.name === "fail"
          ? "fixture failed"
          : JSON.stringify({
              text: request.params.arguments.text,
              cwd: process.cwd(),
              credential: process.env.FIXTURE_TOKEN === "fixture-only",
            }),
    },
  ],
}));
await server.connect(new StdioServerTransport());
