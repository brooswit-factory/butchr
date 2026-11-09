import {syncDirectory,writeDurableFile,unsafeGroupOtherBits} from "./writer.js";
import {unsafeWindowsAcl} from "./windows-acl.js";
import {lstatSync,readFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const identityPattern=/^remote:[0-9a-f-]{36}:[0-9a-f-]{36}:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const identity={test:(value:string)=>identityPattern.test(value)&&value.split(':').at(-1)!.length<=64};
export function createRemoteOverrides(directory:string,sync:typeof syncDirectory=syncDirectory){
 const path=join(directory,'remote-overrides.json');let enabled=true,disabledRules:string[]=[];
 try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||unsafeGroupOtherBits(stat.mode)||unsafeWindowsAcl(path)||stat.size>2_000_000)throw Error('Unsafe remote override file');const value=JSON.parse(readFileSync(path,'utf8'));if(typeof value.enabled!=='boolean'||!Array.isArray(value.disabledRules)||value.disabledRules.length>10000||value.disabledRules.some((id:unknown)=>typeof id!=='string'||!identity.test(id)))throw Error('Invalid remote overrides');enabled=value.enabled;disabledRules=[...new Set<string>(value.disabledRules)];}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 function snapshot(){return {enabled,disabledRules:[...disabledRules]};}
 function update(input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid remote override');const value=input as Record<string,unknown>;
  let nextEnabled=enabled,nextRules=[...disabledRules];
  if(Object.keys(value).length===1&&typeof value.enabled==='boolean')nextEnabled=value.enabled;
  else if(Object.keys(value).length===2&&typeof value.ruleId==='string'&&identity.test(value.ruleId)&&typeof value.disabled==='boolean'){nextRules=nextRules.filter(id=>id!==value.ruleId);if(value.disabled)nextRules.push(value.ruleId);}
  else throw Error('Invalid remote override');
  if(nextRules.length>10000)throw Error('Override limit reached');
  const temp=join(directory,`.remote-overrides-${randomUUID()}.tmp`);
  try{writeDurableFile(temp,JSON.stringify({enabled:nextEnabled,disabledRules:nextRules}),'wx',0o600);renameSync(temp,path);enabled=nextEnabled;disabledRules=nextRules;sync(directory);}finally{try{unlinkSync(temp);}catch{}}
  enabled=nextEnabled;disabledRules=nextRules;return snapshot();
 }
 return {snapshot,update,isDisabled:(id:string)=>disabledRules.includes(id)};
}
