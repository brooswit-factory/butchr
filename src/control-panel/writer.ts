import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,lstatSync,openSync,fsyncSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {lockDownAcl,unsafeWindowsAcl} from './windows-acl.js';
/** Kernel-backed SQLite lock: exclusive ownership, automatically released on process death. */
export function acquireRuntimeWriter(directory:string){
 const path=join(directory,'.control-panel-writer.sqlite');
 const existed=existsSync(path);
 // Permission-safety checks (unsafeGroupOtherBits, unsafeWindowsAcl) are deliberately NOT
 // here: a fresh winner's just-created lock file still carries its default, momentarily-
 // permissive mode/ACL — this function's own chmodSync/lockDownAcl below haven't run yet
 // — until BEGIN EXCLUSIVE below actually confirms exclusive ownership. A competitor
 // racing that fresh creation sees existed=true for the winner's not-yet-secured file;
 // checking permission-safety here would make it observe that transient window and
 // wrongly classify the file as permanently unsafe instead of reaching the normal
 // contention path below. Native testing found this on Windows ACL (FACTORY-1043); a
 // real concurrent-creation CI run hit the identical race on POSIX mode bits (the gap
 // between Database(create:true)'s default mode and this function's own chmodSync).
 // Only the structural checks that don't depend on that timing — regular file, not a
 // symlink — run here; the permission checks move to after BEGIN EXCLUSIVE succeeds.
 if(existed){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Unsafe control-panel runtime lock');}
 const db=new Database(path,{create:true});chmodSync(path,0o600);
 try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}catch{db.close();throw Error('Another control-panel client owns this runtime directory');}
 if(existed){
  // Reaching here means no one else held this file exclusively, so it isn't a fresh
  // winner's transient pre-lockdown window — it's either already secured from a prior
  // run, or genuinely compromised. Safe (and still fail-closed) to check now.
  if(unsafeGroupOtherBits(lstatSync(path).mode)||unsafeWindowsAcl(path)){db.exec('ROLLBACK');db.close();throw Error('Unsafe control-panel runtime lock');}
 }
 // Only now, once BEGIN EXCLUSIVE has actually succeeded, are we guaranteed the sole
 // owner of this directory — locking the ACL down any earlier (e.g. right after creating
 // the file, before this exclusivity gate) let two racing processes both attempt it on
 // the SAME brand-new file/directory at once, which native testing found could spuriously
 // fail with "SeSecurityPrivilege". This file holds no credentials (just an empty lock
 // marker), so the brief window where it exists under the directory's ambient ACL before
 // this runs is an acceptable, deliberate tradeoff against reintroducing that race.
 if(!existed){
  // A lockdown failure here (PowerShell/Set-Acl itself, or its own readback) must not
  // leave the exclusive transaction and db handle open with no way to release them — a
  // review finding: throwing before the release closure below is ever constructed leaks
  // both. Roll back, close, and remove the lock file this call just created (so the next
  // attempt starts clean and retries the lockdown) before propagating the real error.
  try{lockDownAcl(path);}
  catch(e){
   try{db.exec('ROLLBACK');}finally{db.close();}
   try{unlinkSync(path);}catch{}
   throw e;
  }
 }
 let released=false;return ()=>{if(released)return;released=true;try{db.exec('ROLLBACK');}finally{db.close();}};
}
/**
 * Durability for a completed rename/link landing in its directory entry. Windows has no
 * supported equivalent reachable from node:fs — FlushFileBuffers on a directory handle
 * opened without backup-semantics access returns EPERM (confirmed on native Windows,
 * FACTORY-1043) — so this is a no-op there; the file's own fsync (writeDurableFile) already
 * covers the file's own content durability on every platform.
 */
export function syncDirectory(directory:string){
 if(process.platform==='win32')return;
 const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
/**
 * fsync requires a handle opened for writing; reopening a just-written file read-only to
 * fsync it fails EPERM on Windows.
 *
 * Explicit per-file ACL lockdown, BEFORE any content is written: an earlier version of
 * this function relied on the parent directory's own lockdown propagating via
 * inheritance instead, to avoid a PowerShell invocation on every write — native testing
 * DISPROVED that assumption with a real, reproduced exposure (FACTORY-1043): a directory
 * locked down exactly as intended (owner/SYSTEM/Administrators only) can still report
 * `InheritanceFlags=None` on its own ACEs, meaning nothing propagates to new children at
 * all; a file then created inside it got Windows' own default DACL instead, which
 * includes an unrelated logon-session SID with read/execute access — confirmed by writing
 * real (test-only) content into exactly such a file and inspecting its resulting ACL.
 * Correctness/security here matters more than the write-path latency this adds; slower
 * than hoped, but inheritance cannot be trusted to have actually taken effect. Skips
 * lockDownAcl's own extra readback (its `readback` param) on this hot per-write path —
 * see that function's own doc comment for why that's a deliberate, bounded tradeoff
 * rather than a silent gap.
 */
export function writeDurableFile(path:string,text:string,flags:string,mode:number){
 const fd=openSync(path,flags,mode);
 try{lockDownAcl(path,undefined,false);writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
}
/**
 * NTFS has no POSIX group/other permission bits: chmodSync can only toggle the read-only
 * attribute, so a writable file's reported `mode` is always wide-open (typically 0o666) on
 * Windows regardless of the mode it was created with. Treating that as "unsafe" would make
 * every private control-panel file unreadable on restart, so this check is POSIX-only —
 * Windows still gets the isFile/not-a-symlink checks at each call site, just not this one.
 */
export function unsafeGroupOtherBits(mode:number){return process.platform!=='win32'&&(mode&0o077)!==0;}
