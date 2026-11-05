import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve,parse,join,relative} from 'node:path';
import {instanceFreezeStore} from '@brooswit/drovr-events';
import {workspaceRoot} from '../agents/workspace.js';
/** Selected nonsecret paths from the actual daemon, including EnvironmentFile overrides.
 * Never inspect environment files or enumerate environment values. */
export function effectiveMaintenancePaths(){return {pid:process.pid,runtime:process.cwd(),freezeRoot:instanceFreezeStore.root,workspaces:workspaceRoot()};}
/** Missing freeze state means no persisted veto, as in InstanceFreezeStore.read.
 * Inspect every existing ancestor without creating anything or following symlinks. */
export function inspectFreezeRoot(path:string){
 if(!isAbsolute(path)||resolve(path)!==path||path===parse(path).root)throw Error('Freeze root must be an explicit canonical absolute directory');
 let current=parse(path).root,missing=false;
 for(const part of relative(current,path).split(/[\\/]/)){
  current=join(current,part);if(missing)continue;
  try{const s=lstatSync(current);if(s.isSymbolicLink()||!s.isDirectory()||realpathSync(current)!==current)throw Error('Freeze root ancestry must contain only canonical directories');
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;missing=true;}
 }
 return {path,present:!missing};
}
