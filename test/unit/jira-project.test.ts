import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AtlassianClient} from '../../src/atlassian/client.js';
import {parseRules} from '../../src/rules/rules.js';
import {encodeAgentKey,decodeAgentKey} from '../../src/rules/agent-key.js';
import {createJiraProjectResourceType,specForProject,ownsJiraProjectAgent} from '../../src/rules/jira-project-type.js';
import {buildWorkspace,mcpIdentityHeaders} from '../../src/agents/workspace.js';
import {agentStartParams} from '../../src/agents/argv.js';
import {callerIdentity} from '../../src/mcp/identity.js';
import {parseProjectQuery} from '../../src/resources/jira-project.js';
const rule={id:'managers',resourceProvider:'jira-project',query:'{"leadAccountId":"me"}',brief:'Await operator direction.'};
const clean:(()=>void)[]=[];afterEach(()=>{for(const f of clean.splice(0).reverse())f();});

/**
 * BUTCHR-425 AC7 — deploy-hazard regression test. Codey's live rules file
 * (BUTCHR_RULES_FILE=/home/brooswit/.config/butchr/project-managers/rules.json,
 * verified read-only on Codey — see BUTCHR-425 comment 24137) carries rules
 * in EXACTLY this shape: these seven fields, no others — no `execution`,
 * `account`, `role`, or any linked-eventing field. `mcpConfigFile` exists
 * only on this branch; main's rule-field allowlist (RULE_FIELDS, rules.ts)
 * otherwise rejects unknown fields and would make the merged daemon exit at
 * startup the moment it read one of Codey's real rules (the exact hazard
 * already hit once on BUTCHR-421). This test must fail if `jira-project` or
 * `mcpConfigFile` is ever rejected again.
 */
test('BUTCHR-425 AC7 (deploy hazard): a jira-project rule in Codey\'s exact live shape — id, enabled, resourceProvider, query, brief, agentPreferences, mcpConfigFile, nothing else — loads without error and keeps mcpConfigFile', () => {
  const codeyShapedRule = {
    id: 'pm-butchr',
    enabled: true,
    resourceProvider: 'jira-project',
    query: '{"keys":["BUTCHR"]}',
    brief: 'Manage the BUTCHR project per operator direction.',
    agentPreferences: [{ harness: 'claude' }],
    mcpConfigFile: '/home/brooswit/.config/butchr/project-managers/mcp.json',
  };
  expect(Object.keys(codeyShapedRule).sort()).toEqual(['agentPreferences', 'brief', 'enabled', 'id', 'mcpConfigFile', 'query', 'resourceProvider'].sort());
  const [parsed] = parseRules({ rules: [codeyShapedRule] });
  expect(parsed).toMatchObject({
    id: 'pm-butchr',
    enabled: true,
    resourceProvider: 'jira-project',
    query: '{"keys":["BUTCHR"]}',
    brief: 'Manage the BUTCHR project per operator direction.',
    agentPreferences: [{ harness: 'claude' }],
    mcpConfigFile: '/home/brooswit/.config/butchr/project-managers/mcp.json',
  });
  // And the whole live file — two rules, both this shape — loads as a unit too.
  const liveFileShape = { rules: [codeyShapedRule, { ...codeyShapedRule, id: 'pm-atmo', query: '{"keys":["ATMO"]}' }] };
  expect(parseRules(liveFileShape)).toHaveLength(2);
});
test('project rules validate queries, isolate identity and reject workflow relationships',()=>{
 const r=parseRules({rules:[rule]})[0]!;expect(r.resourceProvider).toBe('jira-project');
 for(const query of ['bad','[]','{"unknown":true}','{"keys":[]}','{"leadAccountId":""}','{"query":3}','{"keys":["PROJ-1"]}'])expect(()=>parseProjectQuery(query)).toThrow();
 expect(()=>parseRules({rules:[{...rule,relationships:{childRule:'managers'}}]})).toThrow();
 expect(()=>parseRules({rules:[{...rule,mcpConfigFile:'relative.json'}]})).toThrow();
 expect(()=>parseRules({rules:[{...rule,resourceProvider:'jira-work',query:'x',mcpConfigFile:'/x'}]})).toThrow();
 const key=encodeAgentKey({resourceProvider:'jira-project',ruleId:'managers',resourceId:'PROJ'});
 expect(decodeAgentKey(key)?.resourceId).toBe('PROJ');expect(ownsJiraProjectAgent(key)).toBe(true);expect(ownsJiraProjectAgent('jira-work:managers:PROJ-1')).toBe(false);
 expect(callerIdentity({'x-butchr-agent':key})).toMatchObject({provider:'jira-project',resource:'PROJ'});
 expect(callerIdentity({'x-butchr-agent':key,'x-issue':'PROJ-1'})).toBeNull();
});
test('project discovery deduplicates, skips archived, preserves empty results and fails a whole poll',async()=>{
 const rules=parseRules({rules:[rule,{...rule,id:'disabled',enabled:false}]});let calls=0;
 const type=createJiraProjectResourceType({rules,search:async()=>{calls++;return [{id:'1',key:'PROJ',name:'Project'},{id:'1',key:'PROJ',name:'Project'},{id:'2',key:'OLD',name:'Old',archived:true}];},prepare:async s=>({...s,summary:'prepared'})});
 const matches=await type.discovery.search();expect(calls).toBe(1);expect(matches).toHaveLength(1);expect(type.spawnConfig.specFor(matches[0]!).summary).toBe('prepared');
 expect(type.activation.verdictFor(matches[0]!)).toBe('active');
 const poll=await type.eventRules.poll({primary:[],related:[]},{primary:matches,related:[]});expect(poll.changedPrimary).toEqual([]);expect(await poll.decide('x','x','primary')).toEqual({deliver:false});
 const bad=createJiraProjectResourceType({rules,search:async()=>{throw Error('offline')}});await expect(bad.discovery.search()).rejects.toThrow('offline');
 expect(await createJiraProjectResourceType({rules:[],search:async()=>{throw Error('must not search')}}).discovery.search()).toEqual([]);
 expect(specForProject({...matches[0]!,spec:undefined} as any).brief).toBe(rule.brief);
});
test('project search paginates before filtering by owner and keys; failures never become empty results',async()=>{
 const paths:string[]=[];
 const client=new AtlassianClient('https://jira.test','u','secret',async url=>{
 paths.push(String(url));return Response.json(String(url).endsWith('/myself')?{accountId:'me'}:String(url).includes('startAt=0')?{values:[{id:'1',key:'A',name:'A',lead:{accountId:'other'}}],total:2,isLast:false}:{values:[{id:'2',key:'B',name:'B',lead:{accountId:'me'}}],total:2,isLast:true});
 });
 expect(await client.searchProjects('{"leadAccountId":"me","keys":["B"],"query":"project"}')).toEqual([{id:'2',key:'B',name:'B',leadAccountId:'me'}]);expect(paths).toHaveLength(3);expect(paths[1]).toContain('expand=lead');
 for(const body of [{values:[],total:1},{values:[{id:'1',key:'A',name:'A'}],total:1},{values:[{}],total:1},{values:'bad'}]){
 const c=new AtlassianClient('https://jira.test','u','s',async()=>Response.json(body));await expect(c.searchProjects('{"leadAccountId":"owner"}')).rejects.toThrow();
 }
});
test('free-form project workspace has no ticket workflow, preserves review and carries external MCP identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'project-workspace-'));const before=process.env.BUTCHR_WORKSPACES;process.env.BUTCHR_WORKSPACES=dir;clean.push(()=>{if(before===undefined)delete process.env.BUTCHR_WORKSPACES;else process.env.BUTCHR_WORKSPACES=before;rmSync(dir,{recursive:true,force:true});});
 const spec=specForProject({agentKey:'jira-project:managers:PROJ',rule:parseRules({rules:[rule]})[0]!,project:{id:'1',key:'PROJ',name:'Project'}});
 spec.externalMcpServers=[{name:'resource_chat',url:'http://localhost/chat',headers:{Authorization:'Bearer test'}}];
 const cwd=buildWorkspace(spec,'http://localhost/mcp','codex',[]);
 expect(readFileSync(join(cwd,'AGENTS.md'),'utf8')).toContain('free-form');expect(readFileSync(join(cwd,'.codex/config.toml'),'utf8')).toContain('auto_review');
 expect(mcpIdentityHeaders(spec)).toEqual({'x-butchr-agent':spec.key});
 const args=agentStartParams(spec,cwd,'pane','test',{provider:'codex',disabledMcpServers:[]}).args!;
 expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');expect(args.join(' ')).toContain('resource_chat');
 buildWorkspace(spec,'http://localhost/mcp','claude');expect(JSON.parse(readFileSync(join(cwd,'mcp.json'),'utf8')).mcpServers.resource_chat.url).toBe('http://localhost/chat');
});
