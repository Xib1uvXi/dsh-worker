import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export async function checkRuntimeDependencies() {
  try {
    // Resolve the public persistence module from the same installed runtime
    // used by the SDK, including nested dependency layouts.
    const sdk = createRequire(
      import.meta.resolve("@deepseek-ai/dsh-sdk-client"),
    );
    const runtime = createRequire(sdk.resolve("@deepseek-ai/dsh/package.json"));
    await import(
      pathToFileURL(
        runtime.resolve("@deepseek-ai/dsh-session-persistence-jsonl"),
      ).href
    );
  } catch (cause) {
    throw Object.assign(
      new Error(
        `Harness persistence dependencies could not load: ${String(cause)}. ` +
          "Install with required lifecycle scripts enabled. If scripts were skipped, run npm rebuild fs-ext in the installation directory, then rerun doctor; see docs/troubleshooting.md.",
        { cause },
      ),
      { code: "runtime_dependencies" },
    );
  }
}
