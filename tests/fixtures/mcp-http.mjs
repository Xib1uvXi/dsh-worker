import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const http = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer fixture-only") {
    res.writeHead(401).end();
    return;
  }
  const server = new Server(
    { name: "http-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "echo",
        description: "HTTP fixture",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
      {
        name: "fail",
        description: "Failure fixture",
        inputSchema: { type: "object" },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (r) => ({
    isError: r.params.name === "fail",
    content: [
      { type: "text", text: String(r.params.arguments?.text ?? "failed") },
    ],
  }));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500).end();
  }
});
http.listen(0, "127.0.0.1", () =>
  writeFileSync(process.argv[2], `http://127.0.0.1:${http.address().port}/mcp`),
);
