import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {acquireRuntimeWriter} from '../control-panel/writer.js';
export interface RetirementWriterIdentity{kind:'exclusive-control-directory-writer';path:string;device:number;inode:number;owner:number;}
/** Inspect only the existing lock used by every supported control-panel daemon.
 * Planning never creates it, opens SQLite, or inspects unrelated processes. */
export function retirementWriterIdentity(directory:string):RetirementWriterIdentity{
 const path=join(directory,'.control-panel-writer.sqlite');if(resolve(directory)!==directory||realpathSync(directory)!==directory||realpathSync(path)!==path)throw Error('Existing canonical runtime writer lock required');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=fstatSync(fd),named=lstatSync(path);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.nlink!==1||s.dev!==named.dev||s.ino!==named.ino)throw Error('Unsafe or changed runtime writer lock');return {kind:'exclusive-control-directory-writer',path,device:s.dev,inode:s.ino,owner:s.uid};}finally{closeSync(fd);}
}
/** Hold the SAME kernel-backed SQLite transaction as daemon startup. A daemon
 * cannot initialize its control-panel or worker rollout while this lease is held.
 * The canary-control lock independently excludes other retirement/permit writers. */
export function claimRetirementWriter(directory:string,expected:RetirementWriterIdentity){
 const assertOwned=()=>{const actual=retirementWriterIdentity(directory);if((['kind','path','device','inode','owner'] as const).some(key=>actual[key]!==expected?.[key]))throw Error('Runtime writer lock identity changed; inspect before retry');};
 assertOwned();const release=acquireRuntimeWriter(directory);try{assertOwned();}catch(e){release();throw e;}
 return {assertOwned,release};
}
export type ServiceProperties=Record<string,string>;
/** Service-manager state plus the live writer lease proves the relevant product
 * writers are quiescent, without classifying SSH/systemd/provider processes. */
export function assertRetirementServicesStopped(runtime:string,unit:string,show:(unit:string)=>ServiceProperties){
 if(!/^butchr(?:-[A-Za-z0-9_-]+)?\.service$/.test(unit))throw Error('Existing Butchr user unit required');
 for(const selected of [unit,'butchr-health-watchdog.timer','butchr-health-watchdog.service']){
  const s=show(selected);
  if(selected===unit&&(s.WorkingDirectory!==runtime||!s.ExecStart?.includes(join(runtime,'dist/butchr.js'))))throw Error('Selected service binding differs from inspected release');
  if(s.ActiveState!=='inactive'||s.SubState!=='dead'||s.Job!==''||selected.endsWith('.service')&&s.MainPID!=='0')throw Error('Daemon/watchdog must be independently stopped with no pending job: '+selected);
 }
}
