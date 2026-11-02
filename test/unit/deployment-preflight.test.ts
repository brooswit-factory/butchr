import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectRuleSchema,readWorkerInventory} from '../../scripts/deploy/preflight.js';

test('preflight accepts compatible schema without changing definitions and rejects malformed authority policy',()=>{
 const dir=mkdtempSync(join(tmpdir(),'deployment-preflight-')),rules=join(dir,'rules.json'),authority=join(dir,'authority.json');
 try{
  const text=JSON.stringify({rules:[{id:'fixture',resourceProvider:'jira-work',query:'project = FIXTURE',brief:'Synthetic preflight',enabled:false}]});writeFileSync(rules,text);
  expect(inspectRuleSchema(rules)).toEqual({schemaCompatible:true,authorityActive:false,retained:0});expect(readFileSync(rules,'utf8')).toBe(text);
  writeFileSync(authority,JSON.stringify({active:true,baseline:{rules:[]},remote:[],observationGraph:[],history:[{invalid:true}],retained:[]}));
  expect(()=>inspectRuleSchema(rules,authority)).toThrow();expect(readFileSync(rules,'utf8')).toBe(text);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('inventory proof is stable across ordering and status updates, changes with physical identity, and reads only worker/pane metadata',async()=>{
 const agents:any[]=[{pane_id:'synthetic-b',workspace_id:'w-b',cwd:'/synthetic/b',agent:'codex',agent_status:'working'},{pane_id:'synthetic-a',workspace_id:'w-a',cwd:'/synthetic/a',agent:'claude',agent_status:'idle'}];let reads=0;
 const client:any={agent:{list:async()=>{reads++;return {agents};}},pane:{list:async()=>({panes:[{pane_id:'synthetic-human',workspace_id:'human-workspace',terminal_id:'human-terminal'}]})}};const first=await readWorkerInventory(client);
 agents.reverse();agents[0].agent_status='working';expect(await readWorkerInventory(client)).toEqual(first);
 agents[0].pane_id='replacement';expect((await readWorkerInventory(client)).identitySHA256).not.toBe(first.identitySHA256);expect(reads).toBe(3);
});
