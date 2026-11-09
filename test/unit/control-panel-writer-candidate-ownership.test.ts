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

/**
 * FACTORY-1043 (source-review hypothesis, comment 52455): ownership must be an explicit
 * success signal from the open itself, not inferred by elimination from a later error's
 * code. A non-EEXIST open failure (here: the candidate's own parent directory doesn't
 * exist, so openSync itself throws ENOENT) means nothing was ever created — proving this
 * never even attempts an unlink (which, if it ran against a real unrelated file sharing
 * that exact path for some other reason, would wrongly delete it).
 */
test('a non-EEXIST failure in the open itself (nothing created) never attempts cleanup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-candidate-open-fail-'));
 try{
  const candidatePath=join(dir,'missing-subdir','candidate.tmp'),targetPath=join(dir,'target');
  expect(()=>createCandidateAndLink(candidatePath,'value\n',targetPath)).toThrow();
  expect(existsSync(join(dir,'missing-subdir'))).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
