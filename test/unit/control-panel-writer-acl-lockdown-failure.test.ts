import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

/**
 * FACTORY-1043 review: if lockDownAcl throws (the exact native failure class repeatedly
 * observed on this ticket — a PowerShell/Set-Acl error, or its own readback), the prior
 * code threw out of acquireRuntimeWriter before ever constructing the release closure,
 * leaking the open db handle and its held exclusive transaction, and leaving the
 * newly-created lock file behind under an unknown ACL state. This exercises that cleanup
 * path directly via a fake `pwsh` on PATH that always fails (platform forced to win32 in
 * a spawned child — this sandbox is Linux).
 */
test('a lockdown failure during acquireRuntimeWriter rolls back/closes the db and removes the lock file it just created, so a later attempt starts clean', async () => {
  const module = resolve(import.meta.dir, '../../src/control-panel/writer.ts');
  const dir = mkdtempSync(join(tmpdir(), 'butchr-acquire-writer-acl-fail-'));
  const fakePwshDir = mkdtempSync(join(tmpdir(), 'butchr-fake-pwsh-'));
  const fakePwshPath = join(fakePwshDir, 'pwsh');
  const lockPath = join(dir, '.control-panel-writer.sqlite');
  writeFileSync(fakePwshPath, '#!/bin/sh\necho "synthetic Set-Acl failure" >&2\nexit 1\n');
  chmodSync(fakePwshPath, 0o755);
  try {
    const failingScript = `
     Object.defineProperty(process,'platform',{value:'win32'});
     import {acquireRuntimeWriter} from ${JSON.stringify(module)};
     let threw = false;
     try { acquireRuntimeWriter(${JSON.stringify(dir)}); } catch (e) { threw = String(e).includes('powershell ACL script failed'); }
     if (!threw) throw Error('expected acquireRuntimeWriter to propagate the lockdown failure');
     console.log('ok');
    `;
    const first = Bun.spawn([process.execPath, '--eval', failingScript], {
      stdout: 'pipe', stderr: 'pipe',
      env: {...process.env, PATH: `${fakePwshDir}:${process.env.PATH}`},
    });
    const [firstOut, firstCode, firstErr] = await Promise.all([new Response(first.stdout).text(), first.exited, new Response(first.stderr).text()]);
    expect(firstErr).toBe('');
    expect(firstOut.trim()).toBe('ok');
    expect(firstCode).toBe(0);
    expect(existsSync(lockPath)).toBe(false); // the lock file the failed attempt created must be cleaned up

    // The real proof the exclusive transaction/db handle from the failed attempt was
    // actually released (not leaked): a totally fresh, ordinary process (real platform,
    // no lockdown needed here) can immediately acquire the SAME directory's lock.
    const retryScript = `
     import {acquireRuntimeWriter} from ${JSON.stringify(module)};
     const release = acquireRuntimeWriter(${JSON.stringify(dir)});
     release();
     console.log('ok');
    `;
    const second = Bun.spawn([process.execPath, '--eval', retryScript], {stdout: 'pipe', stderr: 'pipe'});
    const [secondOut, secondCode, secondErr] = await Promise.all([new Response(second.stdout).text(), second.exited, new Response(second.stderr).text()]);
    expect(secondErr).toBe('');
    expect(secondOut.trim()).toBe('ok');
    expect(secondCode).toBe(0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
    rmSync(fakePwshDir, {recursive: true, force: true});
  }
});
