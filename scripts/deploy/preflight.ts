import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {DrovrClient} from '@brooswit/drovr';
import {parseRules} from '../../src/rules/rules.js';

/** Reads only rule definitions and authority policy; never credentials, transcripts or process environments. */
export function inspectRuleSchema(rulesPath:string,authorityPath?:string){
 const rules=JSON.parse(readFileSync(rulesPath,'utf8')) as unknown;
 parseRules(rules);
 let retained=0,authorityActive=false;
 if(authorityPath){
  const saved=JSON.parse(readFileSync(authorityPath,'utf8')) as {active?:boolean;baseline:{rules:unknown[]};remote:{definition:unknown}[];observationGraph:unknown[];history:unknown[];retained:unknown[]};
  parseRules(saved.baseline);parseRules({rules:saved.remote.map(r=>r.definition)});parseRules({rules:saved.observationGraph});parseRules({rules:saved.history});
  retained=saved.retained.length;authorityActive=saved.active===true;
 }
 return {schemaCompatible:true,authorityActive,retained};
}

export async function readWorkerInventory(client:Pick<DrovrClient,'agent'|'pane'>){
 const {agents}=await client.agent.list();
 const {panes}=await client.pane.list();
 const identities=agents.map(a=>[a.pane_id,a.workspace_id,a.cwd,a.agent,a.agent_session]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 const physical=panes.map(p=>[p.pane_id,p.workspace_id,p.terminal_id]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 return {workers:agents.length,panes:panes.length,identitySHA256:createHash('sha256').update(JSON.stringify([identities,physical])).digest('hex')};
}

if(import.meta.main){
 try{
  const {values}=parseArgs({options:{rules:{type:'string'},authority:{type:'string'},socket:{type:'string'}}});
  if(!values.rules)throw Error('Rule file is required');
  const schema=inspectRuleSchema(values.rules,values.authority);
  const inventory=values.socket?await readWorkerInventory(new DrovrClient({socketPath:values.socket})):undefined;
  console.log(JSON.stringify({...schema,...inventory}));
 }catch{
  // Input paths, definition text and transport errors may contain private operational data.
  console.error('Preflight failed: inspect schema compatibility or read-only inventory locally. No state was changed.');
  process.exitCode=1;
 }
}
