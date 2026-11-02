import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createTelemetryOutbox} from '../../src/control-panel/telemetry.js';
const data={mode:'management-only' as const,controllersEnabled:false,remoteConfigsEnabled:true,transportConnected:true,agentsChecked:true,agentsTruncated:false,agents:[]};
test('HTTPS telemetry persists, restarts, remains source-bound and drains with acknowledgement',async()=>{
 const dir=mkdtempSync(tmpdir()+'/https-outbox-'),source={origin:'https://butchr.example.test',serverId:randomUUID(),authorizationId:randomUUID()},d=randomUUID(),s=randomUUID();let box=createTelemetryOutbox(dir);
 try{expect(box.enqueue(source,d,s,data)).toBe(true);box.stop();box=createTelemetryOutbox(dir);expect(box.summary().queued).toBe(1);let sent=0;
 await box.flush({...source,origin:'https://other.example.test'},async()=>{throw Error('Wrong source');});expect(box.summary().queued).toBe(1);
 await box.flush(source,async events=>{sent++;expect(events[0]!.origin).toBe(source.origin);expect(events[0]!.event.sequence).toBe(1);return 1;});expect(sent).toBe(1);expect(box.summary()).toEqual({queued:0,lastError:null});
 expect(()=>box.enqueue({...source,origin:'http://remote.example.test'},d,s,data)).toThrow();expect(box.summary().queued).toBe(0);
 }finally{box.stop();rmSync(dir,{recursive:true,force:true});}
});
