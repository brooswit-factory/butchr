import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {syncDirectory} from '../../src/control-panel/writer.js';

/**
 * FACTORY-1043 native Windows retest: client.configure() -> syncDirectory() threw
 * EPERM/-4048 on Windows (FlushFileBuffers refuses a directory handle opened without
 * backup-semantics access). There is no node:fs-reachable equivalent on Windows, so
 * syncDirectory is a no-op there; this platform still gets the real fsync.
 */
test('syncDirectory fsyncs the directory on this platform without throwing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-sync-dir-'));
 try{expect(()=>syncDirectory(dir)).not.toThrow();}finally{rmSync(dir,{recursive:true,force:true});}
});

test('syncDirectory is a safe no-op on win32, where Windows exposes no fsync-a-directory equivalent via node:fs',async()=>{
 const module=resolve(import.meta.dir,'../../src/control-panel/writer.ts');
 const script=`
  Object.defineProperty(process,'platform',{value:'win32'});
  import {syncDirectory} from ${JSON.stringify(module)};
  // A real directory path is irrelevant here: win32 must return before ever touching fs.
  syncDirectory('/this/path/does/not/exist/and/must/never/be/opened');
  console.log('ok');
 `;
 const child=Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});
 const [out,code,err]=await Promise.all([new Response(child.stdout).text(),child.exited,new Response(child.stderr).text()]);
 expect(err).toBe('');
 expect(out.trim()).toBe('ok');
 expect(code).toBe(0);
});
