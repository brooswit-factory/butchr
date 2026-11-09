import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {unsafeGroupOtherBits} from '../../src/control-panel/writer.js';

/**
 * FACTORY-1043: NTFS has no POSIX group/other permission bits, so a writable file's
 * reported mode on Windows is always wide-open regardless of the mode it was created
 * with — the POSIX group/other-bits check must not apply there, or every private
 * control-panel file (the sqlite writer lock, control-panel.json, overrides, outbox,
 * remote-rule-authority manifest) becomes unreadable on every restart.
 */
test('flags world/group-accessible modes on this (POSIX) platform',()=>{
 expect(unsafeGroupOtherBits(0o600)).toBe(false);
 expect(unsafeGroupOtherBits(0o644)).toBe(process.platform!=='win32');
 expect(unsafeGroupOtherBits(0o666)).toBe(process.platform!=='win32');
 expect(unsafeGroupOtherBits(0o640)).toBe(process.platform!=='win32');
});

test('never flags anything on win32, where chmod cannot restrict group/other access anyway',async()=>{
 const module=resolve(import.meta.dir,'../../src/control-panel/writer.ts');
 const script=`
  Object.defineProperty(process,'platform',{value:'win32'});
  import {unsafeGroupOtherBits} from ${JSON.stringify(module)};
  const cases=[0o600,0o644,0o666,0o640,0o777];
  if(cases.some(m=>unsafeGroupOtherBits(m)))throw Error('unsafeGroupOtherBits flagged a mode on win32');
  console.log('ok');
 `;
 const child=Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});
 const [out,code,err]=await Promise.all([new Response(child.stdout).text(),child.exited,new Response(child.stderr).text()]);
 expect(err).toBe('');
 expect(out.trim()).toBe('ok');
 expect(code).toBe(0);
});
