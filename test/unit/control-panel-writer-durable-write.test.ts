import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeDurableFile} from '../../src/control-panel/writer.js';

/**
 * FACTORY-1043 review: writeDurableFile must write the ENTIRE payload before fsyncing it,
 * never trusting a single write call to have consumed every byte (the prior bug this
 * ticket fixes was a reopen-read-only-then-fsync pattern; a short partial write before
 * fsync would silently install a truncated identity/config/manifest/outbox file instead).
 * There's no portable way to force Node's underlying write() syscall itself to return a
 * short count from a unit test, so this asserts the externally observable contract
 * (writeFileSync-style full-write semantics) across payload sizes crossing common short
 * I/O boundaries (a few KB OS pipe/stdio buffers, then well past typical single-write caps).
 */
test('writeDurableFile writes the complete payload before fsync, never a truncated prefix',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-durable-write-'));
 try{
  for(const size of [1,4096,65536,1_048_576,4_194_304]){
   const path=join(dir,`payload-${size}.tmp`);
   const text='x'.repeat(size-1)+'\n';
   writeDurableFile(path,text,'wx',0o600);
   const written=readFileSync(path,'utf8');
   expect(written.length).toBe(text.length);
   expect(written).toBe(text);
   expect(statSync(path).size).toBe(Buffer.byteLength(text));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('writeDurableFile honors exclusive-create flags and the requested mode',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-durable-write-'));
 try{
  const path=join(dir,'identity.tmp');
  writeDurableFile(path,'fixture\n','wx',0o600);
  expect(()=>writeDurableFile(path,'fixture\n','wx',0o600)).toThrow();
  // NTFS has no POSIX group/other bits (see unsafeGroupOtherBits), so this mode
  // round-trip only means something on POSIX.
  if(process.platform!=='win32')expect(statSync(path).mode&0o777).toBe(0o600);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
