import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateServerUrl,createControlPanelClient} from '../../src/control-panel/client.js';

test('remote origins require HTTPS; loopback development remains supported',()=>{
 expect(validateServerUrl('https://butchr.brooswit.nexus/')).toBe('https://butchr.brooswit.nexus');
 expect(validateServerUrl('https://example.test:8443')).toBe('https://example.test:8443');
 expect(validateServerUrl('http://127.0.0.1:7731')).toBe('http://127.0.0.1:7731');
 for(const url of ['http://example.test','http://localhost:7731','http://[::1]:7731','https://name:password@example.test','https://example.test/api','https://example.test?key=fixture','https://example.test#key','ftp://example.test','https:example.test','//example.test',' https://example.test'])expect(()=>validateServerUrl(url)).toThrow();
});

test('HTTPS configuration is durable, redirect-fenced and reversible without changing deployment identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'butchr-https-'));
 const calls:{url:string,redirect:RequestInit['redirect']}[]=[];
 const fixtureKey='bsv1_'+'F'.repeat(43);
 const fetchFixture=(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  calls.push({url:String(input),redirect:init?.redirect});
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+fixtureKey);
  return Response.json({error:'Isolated refusal fixture'},{status:401});
 }) as typeof fetch;
 let client=createControlPanelClient(dir,fetchFixture);
 try{
  const deployment=client.deploymentId;
  client.configure({serverUrl:'http://127.0.0.1:7731',key:fixtureKey});await client.connect();
  const before=readFileSync(join(dir,'control-panel.json'),'utf8');
  expect(()=>client.configure({serverUrl:'https://butchr.brooswit.nexus',key:''})).toThrow('Enter a key');
  expect(readFileSync(join(dir,'control-panel.json'),'utf8')).toBe(before);
  expect(()=>client.configure({serverUrl:'http://remote.test',key:fixtureKey})).toThrow();
  expect(readFileSync(join(dir,'control-panel.json'),'utf8')).toBe(before);
  client.configure({serverUrl:'https://butchr.brooswit.nexus',key:fixtureKey});await client.connect();
  expect(client.summary().serverUrl).toBe('https://butchr.brooswit.nexus');expect(client.deploymentId).toBe(deployment);
  const firstSession=client.sessionId;
  client.stop();client=createControlPanelClient(dir,fetchFixture);await client.connect();
  expect(client.summary().serverUrl).toBe('https://butchr.brooswit.nexus');
  expect(client.deploymentId).toBe(deployment);expect(client.sessionId).not.toBe(firstSession);
  client.configure({serverUrl:'http://127.0.0.1:7731',key:fixtureKey});await client.connect();
  expect(client.summary().serverUrl).toBe('http://127.0.0.1:7731');expect(client.deploymentId).toBe(deployment);
  expect(calls.some(c=>c.url==='https://butchr.brooswit.nexus/v1/register')).toBe(true);
  expect(calls.every(c=>c.redirect==='error'&&!c.url.includes(fixtureKey))).toBe(true);
 }finally{client.stop();rmSync(dir,{recursive:true,force:true});}
});
