import { AgentHostError, type AgentHost } from '../typescript/src/index.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agent id for what a person typed: a uuid as it is, else the agent with that exact id or that
 * exact name in the account's list. Two agents with the name is an AgentHostError naming both ids.
 * When nothing matches, or the list cannot be read, the text goes on as given, so the brain's own
 * answer for that id (such as 404 agent_not_found) is what the person sees.
 */
export async function resolveAgent(host: AgentHost, given: string): Promise<string> {
  if (UUID.test(given)) return given;
  let agents: { id: string; name: string }[];
  try {
    agents = await host.agents.list();
  } catch {
    return given;
  }
  if (agents.some((a) => a.id === given)) return given;
  const named = agents.filter((a) => a.name === given);
  if (named.length > 1)
    throw new AgentHostError(409, 'agent_name_ambiguous', `${named.length} agents are named ${given}: ${named.map((a) => a.id).join(', ')}; give the id instead`);
  return named[0]?.id ?? given;
}
