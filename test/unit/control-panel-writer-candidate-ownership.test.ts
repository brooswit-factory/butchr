import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCandidateAndLink} from '../../src/control-panel/writer.js';

/**
 * FACTORY-1043 (PR review finding): createCandidateAndLink must not delete a candidate
 * path it did not itself create. A fresh randomUUID() in the real caller's candidate
 * name makes collision with an unrelated file vanishingly unlikely, but unlikely is not
 * ownership evidence — these use explicit, controlled paths (no randomUUID involved) to
 * deterministically exercise both the EEXIST (not ours) and post-create-failure (ours)
 * cleanup paths.
 */
test('a preexisting file at the candidate path (EEXIST) is preserved untouched, never deleted',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-candidate-eexist-'));
 try{
  const candidatePath=join(dir,'candidate.tmp'),targetPath=join(dir,'target');
  writeFileSync(candidatePath,'not-ours');
  expect(()=>createCandidateAndLink(candidatePath,'new-value\n',targetPath)).toThrow();
  expect(existsSync(candidatePath)).toBe(true);
  expect(readFileSync(candidatePath,'utf8')).toBe('not-ours');
  expect(existsSync(targetPath)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a post-create, non-EEXIST failure (e.g. the link target\'s directory is missing) still cleans up the candidate this call created',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-candidate-postcreate-fail-'));
 try{
  const candidatePath=join(dir,'candidate.tmp'),targetPath=join(dir,'missing-subdir','target');
  expect(()=>createCandidateAndLink(candidatePath,'value\n',targetPath)).toThrow();
  expect(existsSync(candidatePath)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the ordinary case: creates the candidate, links it to the target, and cleans up the candidate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-candidate-ok-'));
 try{
  const candidatePath=join(dir,'candidate.tmp'),targetPath=join(dir,'target');
  createCandidateAndLink(candidatePath,'value\n',targetPath);
  expect(existsSync(candidatePath)).toBe(false);
  expect(readFileSync(targetPath,'utf8')).toBe('value\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a concurrent winner having already landed the target is tolerated (EEXIST on link), candidate still cleaned up',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-candidate-link-eexist-'));
 try{
  const candidatePath=join(dir,'candidate.tmp'),targetPath=join(dir,'target');
  writeFileSync(targetPath,'winner-value\n');
  createCandidateAndLink(candidatePath,'loser-value\n',targetPath);
  expect(existsSync(candidatePath)).toBe(false);
  expect(readFileSync(targetPath,'utf8')).toBe('winner-value\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
