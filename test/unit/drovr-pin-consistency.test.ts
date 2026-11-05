import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// FACTORY-1038: the sibling `../drovr` SDK is a `file:` dependency, so the exact Drovr commit
// is part of the build. The recovery recipe (RECOVERY.md), CI (ci.yml) and the release workflow
// (release.yml) must name the SAME 40-hex commit; they drifted apart before (CI 52d0106,
// RECOVERY.md 9ca451a, main 4df054e) and a release job shipped with no sibling checkout at all.
const root=resolve(import.meta.dir,'../..');
const read=(rel:string)=>readFileSync(resolve(root,rel),'utf8');
const SHA=/\b[0-9a-f]{40}\b/g;
const WORKFLOWS=['.github/workflows/ci.yml','.github/workflows/release.yml'];

function drovrCheckoutRefs(text:string){
  // Every `repository: brooswit-factory/drovr` step must be followed (same step) by a full-SHA ref.
  const steps=text.split(/\n\s*- (?=uses:)/).filter(s=>/repository:\s*brooswit-factory\/drovr\b/.test(s));
  return steps.map(s=>s.match(/\bref:\s*([0-9a-f]{40})\b/)?.[1]??null);
}

test('every workflow that installs butchr checks out Drovr at one full-SHA ref',()=>{
  for(const rel of WORKFLOWS){
    const refs=drovrCheckoutRefs(read(rel));
    expect(refs.length,`${rel} must check out the Drovr sibling`).toBeGreaterThan(0);
    expect(refs.every(r=>r!==null),`${rel} has a Drovr checkout without a pinned full-SHA ref`).toBe(true);
  }
});

test('ci.yml, release.yml and RECOVERY.md agree on a single Drovr commit',()=>{
  const pins=new Set<string>();
  for(const rel of WORKFLOWS)for(const ref of drovrCheckoutRefs(read(rel)))pins.add(ref!);
  const recovery=read('RECOVERY.md');
  const recoveryShas=new Set(recovery.match(SHA)??[]);
  expect(recoveryShas.size,'RECOVERY.md must name exactly one pinned commit').toBe(1);
  for(const sha of recoveryShas)pins.add(sha);
  expect([...pins],'Drovr pin differs between ci.yml / release.yml / RECOVERY.md').toHaveLength(1);
});

test('release.yml builds the sibling SDK and legacy-events before installing butchr',()=>{
  const release=read('.github/workflows/release.yml');
  const sdkBuild=release.indexOf('- name: build pinned sibling SDK sources');
  const legacyBuild=release.indexOf('cd legacy-events');
  const install=release.indexOf('- run: bun install --frozen-lockfile\n');
  expect(sdkBuild,'sibling SDK build step missing').toBeGreaterThan(-1);
  expect(legacyBuild,'legacy-events build missing').toBeGreaterThan(sdkBuild);
  expect(install,'butchr install step missing').toBeGreaterThan(-1);
  expect(install,'butchr install must come after the sibling builds').toBeGreaterThan(legacyBuild);
  expect(release).toMatch(/path:\s*butchr/);
});
