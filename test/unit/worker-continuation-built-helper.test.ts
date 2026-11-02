import {test,expect} from 'bun:test';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {buildContinuationHelper} from '../../scripts/build/continuation-helper.js';
import {continuationPermitFixture} from './worker-continuation-permit.test.js';

test('built pure helper loads inertly and executes append-only synthetic issuance with original receipts intact',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'continuation-library-build-')),f=continuationPermitFixture();
 try{
  const original=readFileSync(f.receiptPath,'utf8'),latch=readFileSync(f.latch,'utf8');
  const path=await buildContinuationHelper(resolve(import.meta.dir,'../..'),directory);
  const helper=await import(pathToFileURL(path).href) as typeof import('../../src/control-panel/worker-rollout.js');
  expect(readFileSync(f.receiptPath,'utf8')).toBe(original);expect(readFileSync(f.latch,'utf8')).toBe(latch);
  const result=await helper.issueExistingTargetContinuationPermit(f.request,f.now);
  expect(result.attemptBudget).toBe(1);expect(readFileSync(f.receiptPath,'utf8')).toBe(original);
 }finally{f.close();rmSync(directory,{recursive:true,force:true});}
});
