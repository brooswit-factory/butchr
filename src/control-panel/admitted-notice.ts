import {deliverNotice,type NotifyDeliveryDeps} from '../notify/deliver.js';
import type {RuntimePolicy} from './rule-runtime.js';
/** A linked-event cursor may advance only after a positive delivery receipt. */
export async function deliverAdmittedNotice(policy:Pick<RuntimePolicy,'notificationContext'|'noticeDisposition'>,agent:string,deps:NotifyDeliveryDeps){
 const context=policy.notificationContext(agent);
 const fence=()=>{if(!context||policy.noticeDisposition(agent,context)!=='deliver')throw Error('Notification awaits an admitted, enabled, connected rule context');};
 fence();
 const result=await deliverNotice({...deps,pushChannel:()=>{fence();return deps.pushChannel();},nudgePrompt:()=>{fence();return deps.nudgePrompt();}});
 // deliverNotice deliberately catches transport exceptions. Do not mistake its
 // non-delivery result for acknowledgment and consume a stateful event cursor.
 if(result.via==='none'||result.via==='prompt'&&!result.delivered)throw Error('Notification was not acknowledged; retain its event baseline');
 return result;
}
