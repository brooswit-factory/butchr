import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,chmodSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireRuntimeWriter} from '../../src/control-panel/writer.js';

/**
 * FACTORY-1043 (native finding, comment 52439): acquireRuntimeWriter must REFUSE a
 * preexisting runtime lock file with an unsafe (group/other-accessible) mode, not
 * silently chmod it to 0600 and accept it. An earlier version of the fix for the
 * fresh-creation-race (deferring the mode check past BEGIN EXCLUSIVE) chmodSync'd the
 * file unconditionally before ever looking at its original mode, which destroyed the
 * evidence of a genuinely compromised preexisting lock before the check ran. POSIX-only:
 * Windows has no such mode bits (unsafeGroupOtherBits always false there).
 */
test.skipIf(process.platform==='win32')('refuses a preexisting lock file with an unsafe mode, without first silently repairing it',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-writer-unsafe-mode-'));
 try{
  const path=join(dir,'.control-panel-writer.sqlite');
  writeFileSync(path,'');
  chmodSync(path,0o666);
  expect(()=>acquireRuntimeWriter(dir)).toThrow('Unsafe control-panel runtime lock');
  // The refusal itself must not have mutated the file's mode on the way to throwing —
  // a silent repair would make the exact bug this test targets invisible on retry.
  expect(statSync(path).mode&0o777).toBe(0o666);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test.skipIf(process.platform==='win32')('reuses an already-safe preexisting lock file across a restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-writer-safe-mode-'));
 try{
  const first=acquireRuntimeWriter(dir);
  first();
  const second=acquireRuntimeWriter(dir);
  second();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
