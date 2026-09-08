import manifest from "../../../package.json" with { type: "json" };
export const runtimeVersion =
  manifest.dependencies["@deepseek-ai/dsh-sdk-client"];
