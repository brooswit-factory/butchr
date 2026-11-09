import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {parseIcaclsPrincipals,lockDownAcl,verifyPrivateAcl,unsafeWindowsAcl,type AclIo} from '../../src/control-panel/windows-acl.js';

/**
 * FACTORY-1043 review: real Windows ACL validation, replacing the POSIX-only
 * unsafeGroupOtherBits bypass on win32. `lockDownAcl`/`verifyPrivateAcl`/`unsafeWindowsAcl`
 * are no-ops on every platform but win32 (exercised directly below), so their actual
 * icacls-driving logic is only reachable by overriding `process.platform` in a spawned
 * child (this sandbox is Linux) — covered in the last test via the injectable AclIo seam,
 * against the documented icacls listing format. UNVERIFIED against real `icacls` output —
 * native Windows confirmation is still needed.
 */
const REALISTIC_ICACLS_LISTING =
  'C:\\Users\\broos\\AppData\\Local\\butchr\\control BUILTIN\\Administrators:(OI)(CI)(F)\n' +
  '                                                   NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n' +
  '                                                   ZIPZOOM\\broos:(OI)(CI)(F)\n' +
  '                                                   ZIPZOOM\\CodexSandboxUsers:(OI)(CI)(RX)\n' +
  '\n' +
  'Successfully processed 1 files; Failed processing 0 files\n';

test('parseIcaclsPrincipals extracts every principal from a realistic multi-line listing, path-prefixed first line included', () => {
  const principals = parseIcaclsPrincipals(REALISTIC_ICACLS_LISTING, 'C:\\Users\\broos\\AppData\\Local\\butchr\\control');
  expect(principals).toEqual(['BUILTIN\\Administrators', 'NT AUTHORITY\\SYSTEM', 'ZIPZOOM\\broos', 'ZIPZOOM\\CodexSandboxUsers']);
});

test('parseIcaclsPrincipals ignores the trailing summary line and blank lines', () => {
  expect(parseIcaclsPrincipals('\nSuccessfully processed 1 files; Failed processing 0 files\n\n', 'C:\\x')).toEqual([]);
});

function fakeIo(listing: string): AclIo & {calls: string[][]} {
  const calls: string[][] = [];
  return {calls, run(args) { calls.push(args); return listing; }};
}

test('every exported function is a no-op (never calls icacls) on every platform but win32', () => {
  const io = fakeIo('irrelevant');
  lockDownAcl('/posix/path', io);
  verifyPrivateAcl('/posix/path', io);
  expect(unsafeWindowsAcl('/posix/path', io)).toBe(false);
  expect(io.calls).toEqual([]);
});

test('on win32: lockDownAcl grants exactly {user, SYSTEM, Administrators SID} with inheritance disabled; verifyPrivateAcl/unsafeWindowsAcl accept that allowed set (by name, SID, or NT AUTHORITY\\ prefix) and refuse any other principal', async () => {
  const module = resolve(import.meta.dir, '../../src/control-panel/windows-acl.ts');
  const script = `
   process.env.USERNAME='broos';
   Object.defineProperty(process,'platform',{value:'win32'});
   import {lockDownAcl,verifyPrivateAcl,unsafeWindowsAcl} from ${JSON.stringify(module)};
   const calls=[];
   const listings={
    'C:\\\\ok':'C:\\\\ok broos:(F)\\n        SYSTEM:(F)\\n        BUILTIN\\\\Administrators:(F)\\n',
    'C:\\\\sid':'C:\\\\sid *S-1-5-32-544:(F)\\n         NT AUTHORITY\\\\SYSTEM:(F)\\n         broos:(F)\\n',
    'C:\\\\bad':'C:\\\\bad broos:(F)\\n         ZIPZOOM\\\\CodexSandboxUsers:(RX)\\n',
   };
   const io={run(args){calls.push(args);const path=args[0];if(!(path in listings))return '';return listings[path];}};

   lockDownAcl('C:\\\\new',io);
   const expectedLockdown=['C:\\\\new','/inheritance:r','/grant:r','broos:(OI)(CI)F','SYSTEM:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'];
   if(JSON.stringify(calls[0])!==JSON.stringify(expectedLockdown))throw Error('unexpected lockDownAcl icacls args: '+JSON.stringify(calls[0]));

   verifyPrivateAcl('C:\\\\ok',io);
   verifyPrivateAcl('C:\\\\sid',io);
   if(unsafeWindowsAcl('C:\\\\ok',io)!==false)throw Error('expected C:\\\\ok to be safe');
   if(unsafeWindowsAcl('C:\\\\sid',io)!==false)throw Error('expected C:\\\\sid (SID-form allowed set) to be safe');
   if(unsafeWindowsAcl('C:\\\\bad',io)!==true)throw Error('expected C:\\\\bad (extra principal) to be unsafe');
   let threw=false;try{verifyPrivateAcl('C:\\\\bad',io);}catch(e){threw=String(e).includes('CodexSandboxUsers');}
   if(!threw)throw Error('expected verifyPrivateAcl to throw naming the unexpected principal');
   console.log('ok');
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
  const [out, code, err] = await Promise.all([new Response(child.stdout).text(), child.exited, new Response(child.stderr).text()]);
  expect(err).toBe('');
  expect(out.trim()).toBe('ok');
  expect(code).toBe(0);
});
