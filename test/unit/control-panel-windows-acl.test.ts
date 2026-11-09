import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {lockDownAcl,verifyPrivateAcl,unsafeWindowsAcl,parseVerifyResultForTest,type AclIo} from '../../src/control-panel/windows-acl.js';

/**
 * FACTORY-1043 review (round 3): real Windows ACL validation via PowerShell's structured
 * Get-Acl/Set-Acl (SIDs, JSON) — a fresh (never Get-Acl-derived) ACL object for lockdown
 * to avoid the SeSecurityPrivilege failure round 2 hit natively, strict schema validation
 * (round 2's silent accept of a missing rules field / empty ownerSid / malformed rule was
 * found independently by native testing), and the object's OWN security-descriptor owner
 * checked separately from the current process's identity.
 *
 * lockDownAcl/verifyPrivateAcl/unsafeWindowsAcl are no-ops on every platform but win32
 * (exercised directly below), so their actual PowerShell-driving logic is only reachable
 * by overriding `process.platform` in a spawned child (this sandbox is Linux) — covered
 * in the last test via the injectable AclIo seam. UNVERIFIED against real PowerShell
 * output — native Windows confirmation is still needed.
 */
function fakeIo(output: string): AclIo & {calls: {script: string; path: string}[]} {
  const calls: {script: string; path: string}[] = [];
  return {calls, run(script, path) { calls.push({script, path}); return output; }};
}

const OWNER = 'S-1-5-21-1111-2222-3333-1001';
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';
const OTHER = 'S-1-5-21-9999-8888-7777-5001';
const okResult = (overrides: Record<string, unknown> = {}) => JSON.stringify({ok: true, currentUserSid: OWNER, ownerSid: OWNER, rules: [{sid: OWNER, accessControlType: 'Allow'}, {sid: SYSTEM, accessControlType: 'Allow'}, {sid: ADMINS, accessControlType: 'Allow'}], ...overrides});

test.skipIf(process.platform === 'win32')('every exported function is a no-op (never invokes PowerShell) on every platform but win32', () => {
  const io = fakeIo('irrelevant');
  lockDownAcl('/posix/path', io);
  verifyPrivateAcl('/posix/path', io);
  expect(unsafeWindowsAcl('/posix/path', io)).toBe(false);
  expect(io.calls).toEqual([]);
});

test('parseVerifyResultForTest: a well-formed result with a plausible owner/rules passes', () => {
  expect(parseVerifyResultForTest(okResult())).toEqual({ok: true, currentUserSid: OWNER, ownerSid: OWNER, rules: [{sid: OWNER, accessControlType: 'Allow'}, {sid: SYSTEM, accessControlType: 'Allow'}, {sid: ADMINS, accessControlType: 'Allow'}]});
});

test('parseVerifyResultForTest: fails closed on unparseable or structurally wrong output', () => {
  for (const bad of ['not json at all', '{"ok":true}', '{"nope":1}', '', '  ', '{"ok":false}']) {
    expect(parseVerifyResultForTest(bad).ok).toBe(false);
  }
  expect(parseVerifyResultForTest('{"ok":false,"error":"boom"}')).toEqual({ok: false, error: 'boom'});
});

test('parseVerifyResultForTest: fails closed on every malformed-input shape native testing independently found accepted (round 2 regression)', () => {
  // A missing `rules` field entirely (not merely an empty array) must fail, not be treated as "no rules".
  const missingRules = JSON.stringify({ok: true, currentUserSid: OWNER, ownerSid: OWNER});
  expect(parseVerifyResultForTest(missingRules).ok).toBe(false);
  // An empty ownerSid string must fail the SID-syntax check, not be accepted as a value.
  expect(parseVerifyResultForTest(okResult({ownerSid: ''})).ok).toBe(false);
  expect(parseVerifyResultForTest(okResult({currentUserSid: ''})).ok).toBe(false);
  // A malformed rule entry (missing sid/accessControlType) must fail the WHOLE result, never be silently skipped.
  expect(parseVerifyResultForTest(okResult({rules: [{}]})).ok).toBe(false);
  expect(parseVerifyResultForTest(okResult({rules: [{sid: OWNER}]})).ok).toBe(false);
  expect(parseVerifyResultForTest(okResult({rules: [{sid: OWNER, accessControlType: 'Maybe'}]})).ok).toBe(false);
  expect(parseVerifyResultForTest(okResult({rules: [{sid: 'not-a-sid', accessControlType: 'Allow'}]})).ok).toBe(false);
  // PowerShell unwraps a single-element array to a bare object — still a valid shape.
  expect(parseVerifyResultForTest(okResult({rules: {sid: OWNER, accessControlType: 'Allow'}})).ok).toBe(true);
  // A genuinely empty rules array is structurally valid (distinct from the field being absent).
  expect(parseVerifyResultForTest(okResult({rules: []})).ok).toBe(true);
});

test('on win32: lockDownAcl builds a fresh ACL object (never Get-Acl-derived) and reads its own result back; verifyPrivateAcl/unsafeWindowsAcl check the OBJECT\'S OWN owner separately from the current process, accept {owner, SYSTEM, Administrators}, ignore Deny rules for unrelated principals, and fail closed on bad output', async () => {
  const module = resolve(import.meta.dir, '../../src/control-panel/windows-acl.ts');
  const script = `
   Object.defineProperty(process,'platform',{value:'win32'});
   import {lockDownAcl,verifyPrivateAcl,unsafeWindowsAcl} from ${JSON.stringify(module)};
   const OWNER='${OWNER}', SYSTEM='${SYSTEM}', ADMINS='${ADMINS}', OTHER='${OTHER}';
   const ok=JSON.stringify({ok:true,currentUserSid:OWNER,ownerSid:OWNER,rules:[{sid:OWNER,accessControlType:'Allow'},{sid:SYSTEM,accessControlType:'Allow'},{sid:ADMINS,accessControlType:'Allow'}]});
   const badAce=JSON.stringify({ok:true,currentUserSid:OWNER,ownerSid:OWNER,rules:[{sid:OWNER,accessControlType:'Allow'},{sid:OTHER,accessControlType:'Allow'}]});
   const denyOtherFine=JSON.stringify({ok:true,currentUserSid:OWNER,ownerSid:OWNER,rules:[{sid:OWNER,accessControlType:'Allow'},{sid:OTHER,accessControlType:'Deny'}]});
   const badOwner=JSON.stringify({ok:true,currentUserSid:OWNER,ownerSid:OTHER,rules:[{sid:OWNER,accessControlType:'Allow'}]});
   const outputs={'C:\\\\ok':ok,'C:\\\\bad-ace':badAce,'C:\\\\deny-other-is-fine':denyOtherFine,'C:\\\\bad-owner':badOwner,'C:\\\\garbled':'not json','C:\\\\new':ok};
   const calls=[];
   const io={run(scriptText,path){calls.push({scriptText,path});if(!(path in outputs))throw Error('unexpected path '+path);return outputs[path];}};

   lockDownAcl('C:\\\\new',io);
   if(calls.length!==2)throw Error('lockDownAcl should invoke the lockdown script then read its own result back, got '+calls.length+' calls');
   if(calls[0].path!=='C:\\\\new'||!/Set-Acl/.test(calls[0].scriptText))throw Error('first call is not the lockdown script against the exact path: '+JSON.stringify(calls[0]));
   if(/Get-Acl[\\s\\S]*Set-Acl/.test(calls[0].scriptText))throw Error('lockdown script must never derive its ACL object from Get-Acl (the SeSecurityPrivilege regression)');
   if(calls[1].path!=='C:\\\\new'||!/Get-Acl/.test(calls[1].scriptText))throw Error('second call is not the readback verify: '+JSON.stringify(calls[1]));

   verifyPrivateAcl('C:\\\\ok',io);
   if(unsafeWindowsAcl('C:\\\\ok',io)!==false)throw Error('expected C:\\\\ok to be safe');
   if(unsafeWindowsAcl('C:\\\\deny-other-is-fine',io)!==false)throw Error('a Deny rule for an unrelated principal must never be treated as unsafe');
   if(unsafeWindowsAcl('C:\\\\bad-ace',io)!==true)throw Error('expected C:\\\\bad-ace (extra Allow principal) to be unsafe');
   if(unsafeWindowsAcl('C:\\\\bad-owner',io)!==true)throw Error('expected C:\\\\bad-owner (unrelated security-descriptor owner) to be unsafe even with otherwise-fine ACEs');
   if(unsafeWindowsAcl('C:\\\\garbled',io)!==true)throw Error('expected unparseable output to fail CLOSED (unsafe), not silently pass');
   let threw=false;try{verifyPrivateAcl('C:\\\\bad-owner',io);}catch(e){threw=String(e).includes('unexpected owner')&&String(e).includes(OTHER);}
   if(!threw)throw Error('expected verifyPrivateAcl to throw naming the unexpected OWNER, distinctly from an ACE');
   console.log('ok');
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
  const [out, code, err] = await Promise.all([new Response(child.stdout).text(), child.exited, new Response(child.stderr).text()]);
  expect(err).toBe('');
  expect(out.trim()).toBe('ok');
  expect(code).toBe(0);
});
