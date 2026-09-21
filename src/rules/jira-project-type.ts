import type { SpawnSpec } from '../agents/workspace.js';
import type { JiraProject } from '../resources/jira-project.js';
import type { ResourceType } from '../resources/types.js';
import { encodeAgentKey, decodeAgentKey } from './agent-key.js';
import type { Rule } from './rules.js';
export interface ProjectMatch { agentKey: string; rule: Rule; project: JiraProject; spec?: SpawnSpec; }
export const ownsJiraProjectAgent = (id: string) => decodeAgentKey(id)?.resourceProvider === 'jira-project';
export function specForProject(m: ProjectMatch): SpawnSpec {
 return m.spec ?? { key:m.agentKey,resource:m.project.key,issuetype:'project',summary:m.project.name,parent:null,brief:m.rule.brief,
 ...(m.rule.agentPreferences ? {agents:m.rule.agentPreferences}:{}), ...(m.rule.mcpConfigFile ? {mcpConfigFile:m.rule.mcpConfigFile}: {}) };
}
export function createJiraProjectResourceType(deps: { rules: readonly Rule[]; search: (query:string)=>Promise<JiraProject[]>; prepare?: (spec:SpawnSpec)=>Promise<SpawnSpec> }): ResourceType<ProjectMatch> {
 return {
 discovery: {idOf:m=>m.agentKey,search:async()=>{
   const groups=await Promise.all(deps.rules.filter(r=>r.enabled&&r.resourceProvider==='jira-project').map(async rule=>{
    const seen=new Set<string>();const matches:ProjectMatch[]=[];
    for(const project of await deps.search(rule.query)) {
     if(project.archived||seen.has(project.key))continue;seen.add(project.key);
     const m:ProjectMatch={agentKey:encodeAgentKey({resourceProvider:'jira-project',ruleId:rule.id,resourceId:project.key}),rule,project};
     matches.push(m);
    }return matches;
   }));
   const matches=groups.flat();
   if(deps.prepare)for(const m of matches)m.spec=await deps.prepare(specForProject(m));
   return matches;
 }},
 activation:{verdictFor:()=> 'active'},
 // Membership controls residency. No ticket/Confluence workflow, auto-assignment, or work prompts.
 eventRules:{poll:async()=>({changedPrimary:[],changedRelated:[],decide:async()=>({deliver:false})})},
 spawnConfig:{specFor:specForProject},
 };
}
