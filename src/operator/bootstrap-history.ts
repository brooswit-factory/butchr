import {constants,openSync,closeSync,readSync,readFileSync,readdirSync,readlinkSync,realpathSync,lstatSync,fstatSync,statSync} from 'node:fs';
import {resolve,isAbsolute,join,basename,dirname} from 'node:path';
import {createHash} from 'node:crypto';
export const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const BOOTSTRAP_PATTERN=/^Drovr context handoff bootstrap\. Do not use tools, change files, or continue work\. Begin your response with (DROVR_HANDOFF_READY_[a-f0-9-]{36}) on its own line, followed by Ready to import historical context\. No history has been imported yet\.$/;
const types=new Set(['mode','permission-mode','atis-latch','file-history-snapshot','attachment','api-request-shape','api-request-blob','api-request','last-prompt','ai-title','assistant','system','user']);
const attachments=new Set(['agent_listing_delta','credential_org','date','deferred_tools_delta','environment','instructions','model','prompt_snapshot','remote_session_change','session_context','skill_listing']);
/** Classify complete native records, never infer absence of work from a screen.
 * Unknown records, tools, backups and any extra user input refuse rollback. */
export function classifyBootstrap(text:string,bootstrap:string,cwd:string,sessionId:string){
 const token=BOOTSTRAP_PATTERN.exec(bootstrap)?.[1];if(!token||!text.endsWith('\n'))throw Error('Complete process-bound bootstrap history required');
 const users:string[]=[],replies:string[]=[],ids=new Set<string>(),cwds=new Set<string>();let records=0;
 for(const line of text.trimEnd().split('\n')){
  const row=JSON.parse(line);records++;if(!types.has(row.type)||row.isSidechain===true)throw Error('Unknown or sidechain work record');
  if(row.sessionId)ids.add(row.sessionId);if(row.cwd)cwds.add(row.cwd);
  if(row.type==='attachment'&&!attachments.has(row.attachment?.type))throw Error('Unknown work-bearing attachment');
  if(row.type==='system'&&row.subtype!=='turn_duration')throw Error('Unknown system work record');
  if(row.type==='file-history-snapshot'&&(!row.snapshot?.trackedFileBackups||typeof row.snapshot.trackedFileBackups!=='object'||Array.isArray(row.snapshot.trackedFileBackups)||Object.keys(row.snapshot.trackedFileBackups).length))throw Error('Complete empty file-work evidence required; preserve useful or uncertain work');
  if(row.type==='user'||row.type==='assistant'){
   const content=row.message?.content;let message:string;
   if(typeof content==='string')message=content;
   else if(Array.isArray(content)&&content.every(b=>b?.type==='text'&&typeof b.text==='string'))message=content.map(b=>b.text).join('\n');
   else throw Error('Non-text input, tools or unknown message blocks');
   (row.type==='user'?users:replies).push(message);
  }
 }
 const ready=replies.length===1?replies[0]!.trim().replace(/\s+/g,' '):'';
 if(users.length!==1||users[0]!==bootstrap||![token+' Ready to import historical context.',token+' Ready to import historical context. No history has been imported yet.'].includes(ready)||ids.size!==1||!ids.has(sessionId)||cwds.size!==1||!cwds.has(cwd))throw Error('Useful work, changed native identity or incomplete bootstrap');
 return {records,userTurns:1 as const,assistantTurns:1 as const,noUsefulWorkProven:true as const};
}
export function statKey(s:NonNullable<ReturnType<typeof statSync>>){return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}
/** Follow only the kernel's exact foreground process and explicitly selected image. */
export function processProof(pid:number,cwd:string,executable:string,procRoot='/proc'){
 if(process.platform!=='linux'||!Number.isSafeInteger(pid)||pid<=1)throw Error('Exact Linux process required');const p=join(procRoot,String(pid));
 if(lstatSync(p).uid!==process.getuid?.()||realpathSync(p+'/cwd')!==cwd||realpathSync(p+'/exe')!==executable||realpathSync(executable)!==executable)throw Error('Process owner, cwd or image changed');
 const image=statSync(p+'/exe'),expected=statSync(executable);if(!expected.isFile()||(expected.mode&0o022)||statKey(image)!==statKey(expected))throw Error('Unsafe or changed executable image');
 const fields=readFileSync(p+'/stat','utf8').split(/\) /).at(-1)!.trim().split(/\s+/),generation=fields[19];if(!/^\d+$/.test(generation??''))throw Error('Process generation unavailable');
 return {pid,generation:generation!,executable,executableIdentity:statKey(image)};
}
/** Pin each canonical directory component. This never retries an inaccessible
 * path via an alternate route; /proc/self/fd only confines our own open handles. */
function directory(path:string){if(!isAbsolute(path)||resolve(path)!==path)throw Error('Explicit canonical project root required');let fd=openSync('/',constants.O_RDONLY|constants.O_DIRECTORY);try{for(const part of path.split('/').filter(Boolean)){const next=openSync(`/proc/self/fd/${fd}/${part}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);closeSync(fd);fd=next;}if(fstatSync(fd).uid!==process.getuid?.()||(fstatSync(fd).mode&0o022))throw Error('Unsafe project owner/permissions');return fd;}catch(e){closeSync(fd);throw e;}}
export interface BootstrapEvidence{path:string;sessionId:string;bytes:number;sha256:string;fileIdentity:string;bootstrapArgumentSHA256:string;records:number;userTurns:1;assistantTurns:1;noUsefulWorkProven:true;}
/** Exact argv nonce binds a closed-log-file session to this process. No newest
 * cwd guess, global history search, credential read or native-ref fabrication. */
export function inspectBootstrap(pid:number,cwd:string,executable:string,root:string,procRoot='/proc'):BootstrapEvidence{
 const before=processProof(pid,cwd,executable,procRoot),cmdline=readFileSync(join(procRoot,String(pid),'cmdline')),args=cmdline.toString('utf8').split('\0');
 if(args.some(a=>/^(--resume|--continue|-c)(=|$)/.test(a)))throw Error('Resumed sessions are not bootstrap-only transactions');
 const matches=args.filter(a=>BOOTSTRAP_PATTERN.test(a));if(matches.length!==1)throw Error('One generated bootstrap nonce required');const bootstrap=matches[0]!,token=BOOTSTRAP_PATTERN.exec(bootstrap)![1]!;
 if(basename(root)!==cwd.replace(/[^a-zA-Z0-9]/g,'-')||basename(dirname(root))!=='projects')throw Error('Exact permitted Claude project directory required');
 const dir=directory(root),rootKey=statKey(fstatSync(dir));const found:BootstrapEvidence[]=[];let budget=0;
 try{const names=readdirSync(`/proc/self/fd/${dir}`).filter(n=>/^[a-f0-9-]{36}\.jsonl$/.test(n));if(names.length>256)throw Error('Bounded project search exceeded');
  for(const name of names){const fd=openSync(`/proc/self/fd/${dir}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
   const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o022)||s.nlink!==1)throw Error('Unsafe native file');budget+=Math.min(s.size,65536);if(budget>16*1024*1024)throw Error('Native prefix budget exceeded');
   const prefix=Buffer.alloc(Math.min(s.size,65536));readSync(fd,prefix,0,prefix.length,0);if(!prefix.includes(token))continue;
   if(s.size<=0||s.size>1024*1024)throw Error('Bootstrap history exceeds bounded limit');const data=readFileSync(fd),text=new TextDecoder('utf-8',{fatal:true}).decode(data),sessionId=name.slice(0,-6),classification=classifyBootstrap(text,bootstrap,cwd,sessionId);
   if(statKey(s)!==statKey(fstatSync(fd))||statKey(s)!==statKey(statSync(join(root,name)))||realpathSync(join(root,name))!==join(root,name))throw Error('Native history changed during proof');
   found.push({path:join(root,name),sessionId,bytes:data.length,sha256:sha(data),fileIdentity:statKey(s),bootstrapArgumentSHA256:sha(bootstrap),...classification});
  }finally{closeSync(fd);}}
  if(!cmdline.equals(readFileSync(join(procRoot,String(pid),'cmdline')))||rootKey!==statKey(fstatSync(dir))||JSON.stringify(before)!==JSON.stringify(processProof(pid,cwd,executable,procRoot)))throw Error('Process or project changed during proof');
 }finally{closeSync(dir);}
 if(found.length!==1)throw Error('Exactly one process-bound native session required; no guessing');return found[0]!;
}
export function historyPrefixPreserved(evidence:Pick<BootstrapEvidence,'path'|'bytes'|'sha256'>){
 const dir=directory(dirname(evidence.path));try{const fd=openSync(`/proc/self/fd/${dir}/${basename(evidence.path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o022)||s.nlink!==1||s.size<evidence.bytes)return false;const data=Buffer.alloc(evidence.bytes);return readSync(fd,data,0,data.length,0)===data.length&&sha(data)===evidence.sha256&&statKey(s)===statKey(fstatSync(fd));}finally{closeSync(fd);}}finally{closeSync(dir);}
}
