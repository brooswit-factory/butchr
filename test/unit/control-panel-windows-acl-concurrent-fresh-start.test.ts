import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

/**
 * FACTORY-1043 review (deterministic interleaving, native-reproduced): a losing racer in
 * a concurrent FRESH startup must never mistake the winner's just-created
 * .control-panel-writer.sqlite (created strictly before the directory is locked down) for
 * already-provisioned state and refuse the directory as "Unsafe Windows ACL" — it must
 * reach the normal "Another control-panel client owns this runtime directory" contention
 * path instead. This forces the EXACT race window deterministically (process A holds the
 * writer lock open, directory never locked down yet) rather than relying on real-process
 * timing luck, which is what let this regression through CI/local runs before.
 */
test('a competitor against a fresh directory whose writer lock is already held (directory still ambient) gets the normal lock-contention error, never "Unsafe Windows ACL"', async () => {
  const clientModule = resolve(import.meta.dir, '../../src/control-panel/client.ts');
  const writerModule = resolve(import.meta.dir, '../../src/control-panel/writer.ts');
  const dir = mkdtempSync(join(tmpdir(), 'butchr-concurrent-fresh-acl-'));
  const fakePwshDir = mkdtempSync(join(tmpdir(), 'butchr-fake-pwsh-ok-'));
  const fakePwshPath = join(fakePwshDir, 'pwsh');
  // Tracks real lockdown state via a marker file next to the target path, so this
  // actually distinguishes "locked down" from "still ambient" — a fake that always
  // reports safe would never be able to exercise the bug this test targets (confirmed:
  // an earlier, always-safe version of this fake passed even with the bug reintroduced).
  // argv seen by this script is [pwsh, -NoProfile, -NonInteractive, -Command, <scriptText>]
  // (positions $1-$4); a Set-Acl call is the lockdown script, anything else the verify
  // script. The verify script reports an extra, unrelated principal — unsafe — unless the
  // marker for this exact path exists.
  writeFileSync(fakePwshPath, [
    '#!/bin/sh',
    'case "$4" in',
    '  *Set-Acl*)',
    '    touch "$BUTCHR_ACL_PATH.acl-locked"',
    '    exit 0',
    '    ;;',
    '  *)',
    '    if [ -f "$BUTCHR_ACL_PATH.acl-locked" ]; then',
    '      echo \'{"ok":true,"currentUserSid":"S-1-5-21-1-1-1-1000","ownerSid":"S-1-5-21-1-1-1-1000","rules":[{"sid":"S-1-5-21-1-1-1-1000","accessControlType":"Allow"}]}\'',
    '    else',
    '      echo \'{"ok":true,"currentUserSid":"S-1-5-21-1-1-1-1000","ownerSid":"S-1-5-21-1-1-1-1000","rules":[{"sid":"S-1-5-21-1-1-1-1000","accessControlType":"Allow"},{"sid":"S-1-5-21-9-9-9-9999","accessControlType":"Allow"}]}\'',
    '    fi',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(fakePwshPath, 0o755);
  const env = {...process.env, PATH: `${fakePwshDir}:${process.env.PATH}`};
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const holdScript = `
     Object.defineProperty(process,'platform',{value:'win32'});
     import {acquireRuntimeWriter} from ${JSON.stringify(writerModule)};
     acquireRuntimeWriter(${JSON.stringify(dir)}); // never released: holds the exclusive lock, directory never locked down
     process.stdout.write('locked\\n');
     await new Promise(()=>{});
    `;
    holder = Bun.spawn([process.execPath, '--eval', holdScript], {stdout: 'pipe', stderr: 'pipe', env});
    const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('holder never signaled it held the lock')), 5000); }),
      ]);
      expect(new TextDecoder().decode(ready.value)).toContain('locked');
    } finally { clearTimeout(timer); reader.releaseLock(); }

    // Now race a competitor against the SAME directory, with the writer lock already
    // held and the directory's ACL still ambient (never locked down by the holder yet).
    const competitorScript = `
     Object.defineProperty(process,'platform',{value:'win32'});
     import {createControlPanelClient} from ${JSON.stringify(clientModule)};
     try {
      createControlPanelClient(${JSON.stringify(dir)});
      throw Error('expected createControlPanelClient to fail while another process holds the writer lock');
     } catch (e) {
      const message = String(e);
      if (message.includes('Unsafe Windows ACL')) throw Error('BUG: competitor mistook the transient lock file for provisioned state and refused the still-ambient directory: ' + message);
      if (!message.includes('Another control-panel client')) throw Error('expected the normal lock-contention error, got: ' + message);
      console.log('ok');
     }
    `;
    const competitor = Bun.spawn([process.execPath, '--eval', competitorScript], {stdout: 'pipe', stderr: 'pipe', env});
    const [out, code, err] = await Promise.all([new Response(competitor.stdout).text(), competitor.exited, new Response(competitor.stderr).text()]);
    expect(err).toBe('');
    expect(out.trim()).toBe('ok');
    expect(code).toBe(0);
  } finally {
    holder?.kill();
    await holder?.exited;
    rmSync(dir, {recursive: true, force: true});
    rmSync(fakePwshDir, {recursive: true, force: true});
  }
}, 10000);
