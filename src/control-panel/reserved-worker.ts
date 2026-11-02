import {decodeAnyAgentKey} from '../rules/agent-key.js';
/** Legacy local session workers stay outside remote rule authority and destructive reconciliation. */
export function ownsManagedSessionAgent(id:string):boolean {
 const decoded=decodeAnyAgentKey(id);
 return decoded?.resourceProvider==='filesystem'&&decoded.ruleId==='managed-sessions';
}
