import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,lstatSync,openSync,fsyncSync,writeFileSync,closeSync} from 'node:fs';
import {join} from 'node:path';
/** Kernel-backed SQLite lock: exclusive ownership, automatically released on process death. */
export function acquireRuntimeWriter(directory:string){
 const path=join(directory,'.control-panel-writer.sqlite');
 if(existsSync(path)){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('Unsafe control-panel runtime lock');}
 const db=new Database(path,{create:true});chmodSync(path,0o600);
 try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}catch{db.close();throw Error('Another control-panel client owns this runtime directory');}
 let released=false;return ()=>{if(released)return;released=true;try{db.exec('ROLLBACK');}finally{db.close();}};
}
export function syncDirectory(directory:string){const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
/** fsync requires a handle opened for writing; reopening a just-written file read-only to fsync it fails EPERM on Windows. */
export function writeDurableFile(path:string,text:string,flags:string,mode:number){
 const fd=openSync(path,flags,mode);
 try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
}
