import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {lockDownAcl,verifyPrivateAcl,unsafeWindowsAcl,parseVerifyResultForTest,type AclIo} from '../../src/control-panel/windows-acl.js';

/**
 * FACTORY-1043 review (round 2): real Windows ACL validation via PowerShell's structured
 * Get-Acl/Set-Acl (SIDs, JSON), replacing the reverted icacls-text-parsing attempt.
 * lockDownAcl/verifyPrivateAcl/unsafeWindowsAcl are no-ops on every platform but win32
 * (exercised directly below), so their actual PowerShell-driving logic is only reachable
 * by overriding `process.platform` in a spawned child (this sandbox is Linux) — covered in
 * the last test via the injectable AclIo seam. UNVERIFIED against real PowerShell output —
 * native Windows confirmation is still needed.
 */
function fakeIo(output: string): AclIo & {calls: {script: string; path: string}[]} {
  const calls: {script: string; path: string}[] = [];
  return {calls, run(script, path) { calls.push({script, path}); return output; }};
}

test('every exported function is a no-op (never invokes PowerShell) on every platform but win32', () => {
  const io = fakeIo('irrelevant');
  lockDownAcl('/posix/path', io);
  verifyPrivateAcl('/posix/path', io);
  expect(unsafeWindowsAcl('/posix/path', io)).toBe(false);
  expect(io.calls).toEqual([]);
});

test('parseVerifyResultForTest: fails closed on unparseable, malformed, or ok:false output', () => {
  for (const bad of ['not json at all', '{"ok":true}', '{"nope":1}', '', '  ']) {
    const result = parseVerifyResultForTest(bad);
    expect(result.ok).toBe(false);
  }
  const explicit = parseVerifyResultForTest('{"ok":false,"error":"boom"}');
  expect(explicit).toEqual({ok: false, error: 'boom'});
});

test('parseVerifyResultForTest: accepts a well-formed ok result with zero, one, or many rules (PowerShell unwraps a single-element array)', () => {
  expect(parseVerifyResultForTest('{"ok":true,"ownerSid":"S-1-5-21-1-2-3-1001","rules":[]}')).toEqual({ok: true, ownerSid: 'S-1-5-21-1-2-3-1001', rules: []});
  const single = parseVerifyResultForTest('{"ok":true,"ownerSid":"S-1-5-21-1-2-3-1001","rules":{"sid":"S-1-5-18","accessControlType":"Allow"}}');
  expect(single.ok).toBe(true);
});

test('on win32: lockDownAcl invokes the lockdown script against the exact path; verifyPrivateAcl/unsafeWindowsAcl accept {owner SID, SYSTEM, Administrators} and refuse any other principal, by SID — and fail closed on bad output', async () => {
  const module = resolve(import.meta.dir, '../../src/control-panel/windows-acl.ts');
  const script = `
   Object.defineProperty(process,'platform',{value:'win32'});
   import {lockDownAcl,verifyPrivateAcl,unsafeWindowsAcl} from ${JSON.stringify(module)};
   const OWNER='S-1-5-21-1111-2222-3333-1001', SYSTEM='S-1-5-18', ADMINS='S-1-5-32-544', OTHER='S-1-5-21-9999-8888-7777-5001';
   const calls=[];
   const outputs={
    'C:\\\\ok': JSON.stringify({ok:true,ownerSid:OWNER,rules:[{sid:OWNER,accessControlType:'Allow'},{sid:SYSTEM,accessControlType:'Allow'},{sid:ADMINS,accessControlType:'Allow'}]}),
    'C:\\\\bad': JSON.stringify({ok:true,ownerSid:OWNER,rules:[{sid:OWNER,accessControlType:'Allow'},{sid:OTHER,accessControlType:'Allow'}]}),
    'C:\\\\deny-other-is-fine': JSON.stringify({ok:true,ownerSid:OWNER,rules:[{sid:OWNER,accessControlType:'Allow'},{sid:OTHER,accessControlType:'Deny'}]}),
    'C:\\\\garbled': 'not json',
    'C:\\\\new': '',
   };
   const io={run(scriptText,path){calls.push({scriptText,path});if(!(path in outputs))throw Error('unexpected path '+path);return outputs[path];}};

   lockDownAcl('C:\\\\new',io);
   if(calls.length!==1||calls[0].path!=='C:\\\\new')throw Error('lockDownAcl did not invoke the script against the exact path: '+JSON.stringify(calls));
   if(!/Set-Acl/.test(calls[0].scriptText))throw Error('lockdown script does not call Set-Acl');

   verifyPrivateAcl('C:\\\\ok',io);
   if(unsafeWindowsAcl('C:\\\\ok',io)!==false)throw Error('expected C:\\\\ok to be safe');
   if(unsafeWindowsAcl('C:\\\\deny-other-is-fine',io)!==false)throw Error('a Deny rule for an unrelated principal must never be treated as unsafe');
   if(unsafeWindowsAcl('C:\\\\bad',io)!==true)throw Error('expected C:\\\\bad (extra Allow principal) to be unsafe');
   if(unsafeWindowsAcl('C:\\\\garbled',io)!==true)throw Error('expected unparseable output to fail CLOSED (unsafe), not silently pass');
   let threw=false;try{verifyPrivateAcl('C:\\\\bad',io);}catch(e){threw=String(e).includes('S-1-5-21-9999-8888-7777-5001');}
   if(!threw)throw Error('expected verifyPrivateAcl to throw naming the unexpected SID');
   console.log('ok');
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
  const [out, code, err] = await Promise.all([new Response(child.stdout).text(), child.exited, new Response(child.stderr).text()]);
  expect(err).toBe('');
  expect(out.trim()).toBe('ok');
  expect(code).toBe(0);
});
