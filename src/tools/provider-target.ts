import { callerIdentity } from "../mcp/identity.js";
import { Refusal } from "./outcome.js";

/** Identity supplies attribution and a compatible default, never authority. */
export function providerTarget<T>(
  headers: Readonly<Record<string, string>>, target: unknown, provider: string,
  parse: (value: string) => T | null, verb: string,
): { resource: string; ref: T; agent: string; ruleId: string } {
  const who = callerIdentity(headers);
  const resource = target === undefined && who?.provider === provider && "resource" in who
    ? who.resource : target;
  if (typeof resource !== "string") {
    throw new Refusal(`${verb}: provide an explicit target; only a ${provider} agent may call this without a target`);
  }
  const ref = parse(resource);
  if (ref === null) throw new Refusal(`${verb}: invalid ${provider} target ${JSON.stringify(resource)}`);
  return { resource, ref, agent: who?.agent ?? headers["x-issue"] ?? "mcp", ruleId: who && "ruleId" in who ? who.ruleId : headers["x-issue"] ?? "mcp" };
}
