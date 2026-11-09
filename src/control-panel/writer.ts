import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,lstatSync,openSync,fsyncSync,writeFileSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {lockDownAcl,unsafeWindowsAcl} from './windows-acl.js';
/** Kernel-backed SQLite lock: exclusive ownership, automatically released on process death. */
export function acquireRuntimeWriter(directory:string){
 const path=join(directory,'.control-panel-writer.sqlite');
 const existed=existsSync(path);
 if(existed){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||unsafeGroupOtherBits(stat.mode)||unsafeWindowsAcl(path))throw Error('Unsafe control-panel runtime lock');}
 // Lock the ACL down BEFORE sqlite ever writes its header, not after — the Database
 // constructor below is the first write for a brand-new lock file.
 else{const fd=openSync(path,'wx',0o600);closeSync(fd);lockDownAcl(path);}
 const db=new Database(path,{create:true});chmodSync(path,0o600);
 try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}catch{db.close();throw Error('Another control-panel client owns this runtime directory');}
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
 * fsync it fails EPERM on Windows. The ACL is locked down right after creation but BEFORE
 * the (possibly sensitive — an authorization key, a lock, a manifest) content is written,
 * never after: no window where the content sits on disk under a wider ACL than intended.
 */
export function writeDurableFile(path:string,text:string,flags:string,mode:number){
 const fd=openSync(path,flags,mode);
 try{lockDownAcl(path);writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
}
/**
 * NTFS has no POSIX group/other permission bits: chmodSync can only toggle the read-only
 * attribute, so a writable file's reported `mode` is always wide-open (typically 0o666) on
 * Windows regardless of the mode it was created with. Treating that as "unsafe" would make
 * every private control-panel file unreadable on restart, so this check is POSIX-only —
 * Windows still gets the isFile/not-a-symlink checks at each call site, just not this one.
 */
export function unsafeGroupOtherBits(mode:number){return process.platform!=='win32'&&(mode&0o077)!==0;}
