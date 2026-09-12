import { parseArgs } from "node:util";
import { startBridge } from "./bridge.js";
import { bridgeWorkspace } from "./workspace.js";

export async function runBridge(args: string[]) {
  const { values } = parseArgs({ args, options: { "workspace-root": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: butchr-mcp --workspace-root <factory workspace root>");
    return;
  }
  if (!values["workspace-root"]) throw new Error("Workspace root required");
  const { url, identity } = bridgeWorkspace(values["workspace-root"], process.cwd());
  const bridge = await startBridge(url, identity, { onError: () => {
    process.exitCode = 1;
    console.error("Butchr MCP transport failed");
  } });
  const stop = () => { void bridge.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await bridge.closed; }
  finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) {
  try { await runBridge(process.argv.slice(2)); }
  catch {
    console.error("Butchr MCP startup failed; check workspace metadata and bridge registration");
    process.exitCode = 1;
  }
}
