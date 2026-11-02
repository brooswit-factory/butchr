import {test,expect} from 'bun:test';
import {createObservationJournal} from '../../src/control-panel/observation-journal.js';
import {createIssueEventRules} from '../../src/resources/issue.js';
import {createLinkedEventingState} from '../../src/jira-watch/linked-eventing.js';
import {parseRules} from '../../src/rules/rules.js';
import type {JiraIssue,JiraComment} from '../../src/atlassian/types.js';
import type {EventVerdict} from '../../src/resources/types.js';
const issue=(over:Partial<JiraIssue>={}):JiraIssue=>({key:'FIX-1',summary:'Fixture',status:'In Progress',issuetype:'Task',assignee:null,parent:null,updated:'t1',labels:[],...over});
test('stateful issue comment verdict survives disconnect after decide and delivers once after reconnect',async()=>{
 let comments:JiraComment[]=[{id:'c0',body:'human baseline',created:'t1',authorEmail:null}],connected=true,calls=0,delivered=0;
 const rules=createIssueEventRules({comments:async()=>comments});const before=issue();const seed=await rules.poll({primary:[],related:[]},{primary:[before],related:[]});await seed.decide('FIX-1','FIX-1','primary');
 type Intent={decide:()=>Promise<EventVerdict>;verdict?:EventVerdict};
 const journal=createObservationJournal<JiraIssue,Intent>({valid:()=>connected,prepare:async(a,b)=>{const p=await rules.poll({primary:[a],related:[]},{primary:[b],related:[]});return p.changedPrimary.map(()=>({decide:async()=>{calls++;const v=await p.decide('FIX-1','FIX-1','primary');connected=false;return v;}}));},deliver:async i=>{if(!connected)return false;i.verdict??=await i.decide();if(!connected)return false;if(i.verdict.deliver)delivered++;return true;}});
 await journal.submit(before);comments=[{id:'c1',body:'new human comment',created:'t2',authorEmail:null},...comments];const after=issue({updated:'t2'});await journal.submit(after);expect(delivered).toBe(0);expect(journal.status().pending).toBe(true);connected=true;await journal.submit(after);expect(delivered).toBe(1);expect(calls).toBe(1);
 await journal.submit(after);expect(delivered).toBe(1);
});
test('bounded journal checks capacity before any delivery and keeps baseline retryable',async()=>{let sent=0,tooLarge=true;const journal=createObservationJournal<number,number>({valid:()=>true,prepare:async()=>tooLarge?[1,2]:[1],deliver:async()=>{sent++;return true;},limit:1});await journal.submit(0);await journal.submit(1);expect(sent).toBe(0);expect(journal.status().pending).toBe(true);tooLarge=false;await journal.submit(1);expect(sent).toBe(1);});
test('linked eventing failed fenced delivery preserves baseline until retry',async()=>{
 const rule=parseRules({rules:[{id:'worker',resourceProvider:'jira-work',query:'q',brief:'fixture',linkedEventing:true}]})[0]!;
 const owner=issue({issuelinks:[{type:'Blocks',otherEnd:'outward',key:'FIX-2'}] as never});let target=issue({key:'FIX-2',status:'To Do'}),connected=true,sent=0;
 const state=createLinkedEventingState(),match={agentKey:'jira-work:worker:FIX-1',rule,issue:owner};
 const deps={search:async()=>[target],notify:async()=>{if(!connected)throw Error('Fixture disconnected fence');sent++;}};
 await state.runTick([match],deps);target=issue({key:'FIX-2',status:'In Progress',updated:'t2'});connected=false;await expect(state.runTick([match],deps)).rejects.toThrow('fence');expect(sent).toBe(0);connected=true;await state.runTick([match],deps);await state.runTick([match],deps);expect(sent).toBe(1);
});
test('real delivery fallback cannot swallow a disconnect fence and commit linked cursor',async()=>{
 const {deliverAdmittedNotice}=await import('../../src/control-panel/admitted-notice.js');
 const rule=parseRules({rules:[{id:'worker',resourceProvider:'jira-work',query:'q',brief:'fixture',linkedEventing:true}]})[0]!;
 const owner=issue({issuelinks:[{type:'Blocks',otherEnd:'outward',key:'FIX-2'}] as never});let target=issue({key:'FIX-2',status:'To Do'}),connected=true,prompt=0,pushes=0,pause=true;
 const policy={notificationContext:()=> 'admitted',noticeDisposition:()=>connected?'deliver' as const:'defer' as const};
 const state=createLinkedEventingState(),match={agentKey:'jira-work:worker:FIX-1',rule,issue:owner};
 const deps={search:async()=>[target],notify:async()=>{await deliverAdmittedNotice(policy,match.agentKey,{pushChannel:async()=>{pushes++;if(pause)connected=false;return {sent:[],refused:[]};},nudgePrompt:async()=>{prompt++;return {delivered:true};}});}};
 await state.runTick([match],deps);target=issue({key:'FIX-2',status:'In Progress',updated:'t2'});await expect(state.runTick([match],deps)).rejects.toThrow('Notification');expect(prompt).toBe(0);connected=true;pause=false;await state.runTick([match],deps);await state.runTick([match],deps);expect(prompt).toBe(1);expect(pushes).toBe(2);
});
test('recipient lanes retain ordered A updates while B progresses through concurrent updates and reconnect',async()=>{
 type Snapshot={a:number;b:number};type Intent={lane:'a'|'b';version:number};let aEnabled=false,connected=true;const sent:string[]=[];let entered:()=>void=()=>{},resume:()=>void=()=>{},delay=false;
 const journal=createObservationJournal<Snapshot,Intent>({key:i=>i.lane,valid:()=>connected,prepare:async(p,n)=>{if(delay){delay=false;entered();await new Promise<void>(r=>{resume=r;});}return (['a','b'] as const).filter(k=>p[k]!==n[k]).map(lane=>({lane,version:n[lane]}));},deliver:async i=>{if(!connected||i.lane==='a'&&!aEnabled)return false;sent.push(i.lane+i.version);return true;}});
 await journal.submit({a:0,b:0});await journal.submit({a:1,b:1});expect(sent).toEqual(['b1']);await journal.submit({a:2,b:2});expect(sent).toEqual(['b1','b2']);expect(journal.status().remaining).toBe(2);
 delay=true;const started=new Promise<void>(r=>entered=r);const draining=journal.submit({a:3,b:3});await started;const concurrent=journal.submit({a:4,b:4});resume();await Promise.all([draining,concurrent]);expect(sent).toEqual(['b1','b2','b3','b4']);connected=false;await journal.submit({a:5,b:5});expect(sent).toHaveLength(4);connected=true;aEnabled=true;await journal.submit({a:5,b:5});expect(sent).toEqual(['b1','b2','b3','b4','a1','a2','a3','a4','a5','b5']);expect(journal.status().pending).toBe(false);
});
test('real linked engine advances enabled B while disabled A retains dirty baseline and later catches up',async()=>{
 const rule=parseRules({rules:[{id:'worker',resourceProvider:'jira-work',query:'q',brief:'fixture',linkedEventing:true}]})[0]!;
 const match=(id:string,target:string)=>({agentKey:'jira-work:worker:'+id,rule,issue:issue({key:id,issuelinks:[{type:'Blocks',otherEnd:'outward',key:target}] as never})});
 const matches=[match('FIX-A','FIX-2'),match('FIX-B','FIX-3')];let aEnabled=false;const world:Record<string,JiraIssue>={'FIX-2':issue({key:'FIX-2',status:'To Do'}),'FIX-3':issue({key:'FIX-3',status:'To Do'})},sent:string[]=[];
 let clock=0;const state=createLinkedEventingState(),deps={now:()=>clock,search:async(jql:string)=>Object.values(world).filter(i=>jql.includes(i.key)),notify:async(id:string)=>{if(id.endsWith('FIX-A')&&!aEnabled)throw Error('fixture local override');sent.push(id);}};
 await state.runTick(matches,deps);world['FIX-2']=issue({key:'FIX-2',status:'In Progress',updated:'t2'});world['FIX-3']=issue({key:'FIX-3',status:'In Progress',updated:'t2'});await expect(state.runTick(matches,deps)).rejects.toThrow('override');expect(sent).toEqual(['jira-work:worker:FIX-B']);world['FIX-3']=issue({key:'FIX-3',status:'Done',updated:'t3'});await expect(state.runTick(matches,deps)).rejects.toThrow('override');expect(sent).toEqual(['jira-work:worker:FIX-B','jira-work:worker:FIX-B']);aEnabled=true;clock=61*60_000;await state.runTick(matches,deps);await state.runTick(matches,deps);expect(sent).toEqual(['jira-work:worker:FIX-B','jira-work:worker:FIX-B','jira-work:worker:FIX-A']);
});
test('capture real comment verdicts before lane deferral preserves c1 c2 c3 without loss or duplication',async()=>{
 let comments:JiraComment[]=[{id:'c0',body:'baseline',created:'t0',authorEmail:null}],enabled=false;const rules=createIssueEventRules({comments:async()=>comments}),before=issue({updated:'t0'});const seed=await rules.poll({primary:[],related:[]},{primary:[before],related:[]});await seed.decide('FIX-1','FIX-1','primary');
 type Intent={decide:()=>Promise<EventVerdict>;verdict?:EventVerdict};const sent:unknown[]=[];
 const journal=createObservationJournal<JiraIssue,Intent>({key:()=> 'A',valid:()=>true,prepare:async(a,b)=>{const p=await rules.poll({primary:[a],related:[]},{primary:[b],related:[]});return p.changedPrimary.map(()=>({decide:()=>p.decide('FIX-1','FIX-1','primary')}));},capture:async i=>{i.verdict??=await i.decide();},deliver:async i=>{if(!i.verdict?.deliver)return true;if(!enabled)return false;sent.push(i.verdict.reason);return true;}});
 await journal.submit(before);for(let n=1;n<=3;n++){comments=[{id:'c'+n,body:'human '+n,created:'t'+n,authorEmail:null},...comments];await journal.submit(issue({updated:'t'+n}));}enabled=true;await journal.submit(issue({updated:'t3'}));expect(sent).toEqual([{comment:'c1'},{comment:'c2'},{comment:'c3'}]);expect(journal.status().pending).toBe(false);
});

test('notification health records valid quiet/deferred drains but never invalid or failed stages',async()=>{
 let valid=true,success=0,failure:'none'|'prepare'|'capture'|'deliver'='none',defer=false,disconnect=false;
 const journal=createObservationJournal<number,number>({valid:()=>valid,onSuccess:()=>success++,prepare:async()=>{if(failure==='prepare')throw Error('fixture prepare');return [1];},capture:async()=>{if(failure==='capture')throw Error('fixture capture');},deliver:async()=>{if(failure==='deliver')throw Error('fixture delivery');if(disconnect)valid=false;return !defer;}});
 await journal.submit(0);expect(success).toBe(1);await journal.submit(0);expect(success).toBe(2);
 failure='prepare';await journal.submit(1);expect(success).toBe(2);failure='capture';await journal.submit(1);expect(success).toBe(2);failure='deliver';await journal.submit(1);expect(success).toBe(2);
 failure='none';defer=true;await journal.submit(2);expect(success).toBe(3);expect(journal.status().pending).toBe(true);
 valid=false;await journal.submit(3);expect(success).toBe(3);valid=true;disconnect=true;await journal.submit(3);expect(success).toBe(3);
 disconnect=false;valid=true;defer=false;await journal.submit(3);expect(success).toBe(4);expect(journal.status().pending).toBe(false);
});
