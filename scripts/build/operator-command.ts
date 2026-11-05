import {resolve,join} from 'node:path';
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
/** Production and regression build the same standalone operator command. */
export async function buildOperatorCommand(root:string,outdir:string){
 const result=await Bun.build({entrypoints:[resolve(root,'scripts/operator/maintenance.ts')],outdir,naming:'butchr-operator.js',target:'bun'});
 if(!result.success)throw new AggregateError(result.logs,'Operator command build failed');
 const file=join(outdir,'butchr-operator.js'),code=readFileSync(file,'utf8').replace(/^#![^\n]*\n/,'');
 writeFileSync(file,'#!/usr/bin/env bun\n'+code);chmodSync(file,0o755);return file;
}
