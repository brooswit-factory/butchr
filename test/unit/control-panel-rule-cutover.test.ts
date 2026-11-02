import {test,expect} from 'bun:test';
import {prepareRuleCutover,remoteDiscoveryRules} from '../../src/control-panel/rule-cutover.js';
import type {RemoteRule} from '../../src/control-panel/remote-rules.js';
import {parseRules} from '../../src/rules/rules.js';
const serverId='00000000-0000-4000-8000-000000000001',authorizationId='00000000-0000-4000-8000-000000000002',source={serverId,authorizationId};
const document={rules:[{id:'held-worker',resourceProvider:'jira-work',query:'project = FIXTURE',brief:'Preserve instruction bytes\n',enabled:true,execution:'persistent',role:'worker'},{id:'parked',resourceProvider:'jira-work',query:'project = PARKED',brief:'Never reactivate',enabled:false}]};
function remote():RemoteRule[]{return parseRules(document).map(definition=>({id:`remote:${serverId}:${authorizationId}:${definition.id}`,source:'remote',...source,sourceRuleId:definition.id,definition,executionState:'staged'}));}
test('cutover verifies complete semantics and preserves provider/rule identity and disabled definitions',()=>{
 const plan=prepareRuleCutover(document,remote(),source);expect(plan.equivalent).toBe(true);expect(plan.localDigest).toBe(plan.remoteDigest);expect(plan.rules.map(r=>[r.resourceProvider,r.id,r.enabled])).toEqual(parseRules(document).map(r=>[r.resourceProvider,r.id,r.enabled]));expect(plan.bindings[0]!.localRuleId).toBe('held-worker');
});
test('missing/different/unrepresentable rules and cross-authorization data fail closed without logging content',()=>{
 const rows=remote();for(const bad of [rows.slice(1),[{...rows[0]!,definition:{...rows[0]!.definition,brief:'Wrong instructions'}},rows[1]!],[{...rows[0]!,authorizationId:'other'},rows[1]!]]){const plan=prepareRuleCutover(document,bad,source);expect(plan.equivalent).toBe(false);expect(plan.rules).toEqual([]);expect(()=>remoteDiscoveryRules(plan,{enabled:true,disabledRules:[]})).toThrow();}
 const unsupported=prepareRuleCutover({rules:[{...document.rules[0],unexpectedSecret:'DO-NOT-LOG'}]},rows,source);expect(unsupported.equivalent).toBe(false);expect(JSON.stringify(unsupported)).not.toContain('DO-NOT-LOG');
});
test('master/per-rule override only prepares discovery; fake existing workers and admission snapshots remain untouched',()=>{
 const rows=remote(),plan=prepareRuleCutover(document,rows,source),fakeWorkers=[{id:'jira-work:held-worker:FIXTURE-1',status:'frozen',rule:structuredClone(plan.rules[0])}],before=JSON.stringify(fakeWorkers);
 expect(remoteDiscoveryRules(plan,{enabled:false,disabledRules:[]}).every(r=>!r.enabled)).toBe(true);expect(remoteDiscoveryRules(plan,{enabled:true,disabledRules:[rows[0]!.id]}).every(r=>!r.enabled)).toBe(true);expect(remoteDiscoveryRules(plan,{enabled:true,disabledRules:[]})[0]!.enabled).toBe(true);expect(remoteDiscoveryRules(plan,{enabled:true,disabledRules:[]})[1]!.enabled).toBe(false);expect(JSON.stringify(fakeWorkers)).toBe(before);expect(plan.rules[0]!.enabled).toBe(true);
});
test('builtin references compare by complete shipped content, preserving admission fingerprints',async()=>{
 const {briefFor}=await import('../../src/agents/workspace.js');const {ruleFingerprint}=await import('../../src/control-panel/rule-cutover.js');const local={rules:[{...document.rules[0],brief:'@builtin:task'}]};const definitions=parseRules(local),definition={...definitions[0]!,brief:briefFor('task')};const row:RemoteRule={...remote()[0]!,definition};
 expect(prepareRuleCutover(local,[row],source).equivalent).toBe(true);expect(ruleFingerprint(definitions[0]!)).toBe(ruleFingerprint(definition));expect(prepareRuleCutover(local,[{...row,definition:{...definition,brief:definition.brief+'changed'}}],source).equivalent).toBe(false);
});
