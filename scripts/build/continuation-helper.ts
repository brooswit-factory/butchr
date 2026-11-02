import {resolve} from 'node:path';

/** Same pure-library build for releases and self-contained packaged regression fixtures. */
export async function buildContinuationHelper(root:string,outdir:string):Promise<string> {
 const result=await Bun.build({entrypoints:[resolve(root,'src/control-panel/worker-rollout.ts')],outdir,naming:'continuation-helper.js',target:'bun'});
 if(!result.success)throw new AggregateError(result.logs,'Continuation helper build failed');
 return resolve(outdir,'continuation-helper.js');
}
