import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {liveView,type ViewDeps} from '../../src/web/view.js';
import {createCsrfTokenIssuer} from '../../src/web/csrf.js';
import {createControlPanelClient} from '../../src/control-panel/client.js';
test('connection-only API preserves Origin/peer/CSRF protection, private keys and same-process reconnect identity',async()=>{
 const dir=mkdtempSync(tmpdir()+'/servy-connection-api-'),client=createControlPanelClient(dir,(async()=>Response.json({error:'Disposable refusal'},{status:401})) as unknown as typeof fetch),csrf=createCsrfTokenIssuer();let peerAllowed=true;
 const guard={port:0},peerUidCheck=async()=>peerAllowed;
 const deps={controlPanel:client,dashboardOriginGuard:guard,peerUidCheck,csrf,writeGuard:{dashboardOriginGuard:guard,peerUidCheck,csrf}} as unknown as ViewDeps;
 const app=liveView({} as any,deps);app.listen({hostname:'127.0.0.1',port:0});guard.port=app.server!.port!;const url=`http://127.0.0.1:${guard.port}`,sid=client.sessionId,did=client.deploymentId;
 try{
  expect((await fetch(url+'/api/control-panel',{headers:{origin:'https://hostile.invalid'}})).status).toBe(403);
  const initial=await fetch(url+'/api/control-panel',{headers:{origin:url}});expect(initial.status).toBe(200);expect(((await initial.json()) as {configured:boolean}).configured).toBe(false);
  peerAllowed=false;expect((await fetch(url+'/api/control-panel',{headers:{origin:url}})).status).toBe(403);peerAllowed=true;
  const headers={origin:url,'content-type':'application/json'};expect((await fetch(url+'/api/control-panel/reconnect',{method:'POST',headers,body:'{}'})).status).toBe(403);
  const fixtureKey='bsv1_'+'C'.repeat(43);client.configure({serverUrl:'https://example.test',key:fixtureKey});await client.connect();
  const reconnect=await fetch(url+'/api/control-panel/reconnect',{method:'POST',headers:{...headers,'x-butchr-csrf':csrf.token},body:'{}'});expect(reconnect.status).toBe(200);const state=await reconnect.json() as {sessionId:string;deploymentId:string};expect(state.sessionId).toBe(sid);expect(state.deploymentId).toBe(did);expect(JSON.stringify(state)).not.toContain(fixtureKey);
 }finally{client.stop();await app.stop(true);rmSync(dir,{recursive:true,force:true});}
});
