import { request } from "node:http";
import { mkdtemp,rm } from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import { openDatabase } from '@orca-hq/persistence';
import {describe,it,expect,vi} from 'vitest';
import {startManagedService} from '../src/managed-service.js';
import type { LocalTextMessage } from '../src/local-store.js';
import type { ManagedCommandInput, CommandJob } from '../src/managed-commands.js';
const message=(userId:string,id='m-'+userId)=>({id,channel:'slack' as const,userId,destination:'C1',text:'프로젝트 목록',receivedAt:new Date().toISOString()});
const job=(state='succeeded'):CommandJob=>({id:'j1',projectId:'p1',projectName:'demo',prompt:'fix',state,createdAt:'now',updatedAt:`now-${state}`,result:{summary:'완료됨',modifiedFiles:['src/a.ts'],validation:['test passed']}});
describe('managed service',()=>{
 it('binds a Slack thread to its Orca task for natural followup',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hq-thread-'));let receive!:(m:LocalTextMessage)=>Promise<void>;
  const execute=vi.fn(async(_input:ManagedCommandInput)=>({text:'접수',jobId:'j1'}));
  const service=await startManagedService({directory:dir,databasePath:join(dir,'db.sqlite'),port:0,owner:{slackUserId:'owner',telegramUserId:'42'},execute,getJob:()=>job('running'),channelFactory:ports=>{receive=ports.onMessage;return {start:async()=>{},stop:async()=>{},send:async()=>{},status:()=>({slack:true,telegram:true})};}});
  try{await receive({...message('owner','one'),threadId:'thread1'});await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(1),{timeout:2500});
   await receive({...message('owner','two'),threadId:'thread1',text:'계속해줘'});await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(2),{timeout:2500});
   expect(execute.mock.calls[1]?.[0].contextJobId).toBe('j1');
  }finally{await service.stop();await rm(dir,{recursive:true,force:true});}
 });
 it('persists accepted owner commands and ignores other Slack users',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hq-managed-'));const execute=vi.fn(async()=>({text:'목록'}));const send=vi.fn(async()=>{});let receive!:(m:ReturnType<typeof message>)=>Promise<void>;
  const service=await startManagedService({directory:dir,databasePath:join(dir,'db.sqlite'),port:0,owner:{slackUserId:'owner',telegramUserId:'42'},execute,getJob:()=>undefined,channelFactory:ports=>{receive=ports.onMessage;return {start:async()=>{},stop:async()=>{},send,status:()=>({slack:true,telegram:true})};}});
  try{await receive(message('stranger'));await receive(message('owner'));await receive(message('owner'));await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1));expect(execute).toHaveBeenCalledTimes(1);
   const health=await (await fetch(`http://127.0.0.1:${service.port}/health`)).json();expect(health).toMatchObject({mode:'managed',state:'running'});
  }finally{await service.stop();await rm(dir,{recursive:true,force:true});}
 });

 it('replays a terminal job snapshot when completion beats watcher attachment',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hq-managed-race-'));const sent:string[]=[];let receive!:(m:ReturnType<typeof message>)=>Promise<void>;
  const completed=job();
  const service=await startManagedService({directory:dir,databasePath:join(dir,'db.sqlite'),port:0,owner:{slackUserId:'owner',telegramUserId:'42'},execute:async()=>({text:'작업 j1 · demo · 대기',jobId:'j1'}),getJob:()=>completed,channelFactory:ports=>{receive=ports.onMessage;return {start:async()=>{},stop:async()=>{},send:async(_message,text)=>{sent.push(text);},status:()=>({slack:true,telegram:true})};}});
  try{
   await service.notify(completed);
   await receive(message('owner','race-request'));
   await vi.waitFor(()=>expect(sent.some(text=>text.includes('완료됨'))).toBe(true));
  }finally{await service.stop();await rm(dir,{recursive:true,force:true});}
 });

 it('marks an interrupted pending receipt for recovery without executing it again',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hq-managed-pending-'));const databasePath=join(dir,'db.sqlite');const pending=message('owner','pending-request');
  const seed=openDatabase(databasePath);seed.exec("CREATE TABLE managed_receipts(id TEXT PRIMARY KEY,input TEXT NOT NULL,response TEXT,state TEXT NOT NULL DEFAULT 'pending')");seed.prepare('INSERT INTO managed_receipts(id,input,state) VALUES(?,?,?)').run(pending.id,JSON.stringify({id:pending.id,text:pending.text,source:'slack',userId:'owner'}),'pending');seed.close();
  const execute=vi.fn(async()=>({text:'mutated'}));const sent:string[]=[];let receive!:(m:ReturnType<typeof message>)=>Promise<void>;
  const service=await startManagedService({directory:dir,databasePath,port:0,owner:{slackUserId:'owner',telegramUserId:'42'},execute,getJob:()=>undefined,channelFactory:ports=>{receive=ports.onMessage;return {start:async()=>{},stop:async()=>{},send:async(_message,text)=>{sent.push(text);},status:()=>({slack:true,telegram:true})};}});
  try{
   await receive(pending);
   await vi.waitFor(()=>expect(sent).toHaveLength(1),{timeout:2500});
   expect(sent[0]).toContain('결과 확인 필요');expect(execute).not.toHaveBeenCalled();
  }finally{await service.stop();await rm(dir,{recursive:true,force:true});}
 });

 it('reconciles watched jobs from the durable engine snapshot after restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hq-managed-restart-'));const databasePath=join(dir,'db.sqlite');let current=job('running');let receive!:(m:ReturnType<typeof message>)=>Promise<void>;
  const first=await startManagedService({directory:dir,databasePath,port:0,owner:{slackUserId:'owner',telegramUserId:'42'},execute:async()=>({text:'작업 j1 · demo · 실행 중',jobId:'j1'}),getJob:()=>current,channelFactory:ports=>{receive=ports.onMessage;return {start:async()=>{},stop:async()=>{},send:async()=>{},status:()=>({slack:true,telegram:true})};}});
  await receive(message('owner','restart-request'));await new Promise(resolve=>setTimeout(resolve,1100));await first.stop();
  current=job('succeeded');const sent:string[]=[];
  const second=await startManagedService({directory:dir,databasePath,port:0,owner:{slackUserId:'owner',telegramUserId:'42'},execute:vi.fn(async()=>({text:'unexpected'})),getJob:()=>current,channelFactory:()=>({start:async()=>{},stop:async()=>{},send:async(_message,text)=>{sent.push(text);},status:()=>({slack:true,telegram:true})})});
  try{await vi.waitFor(()=>expect(sent.some(text=>text.includes('완료됨'))).toBe(true),{timeout:2500});}
  finally{await second.stop();await rm(dir,{recursive:true,force:true});}
 });
});

function terminalCall(socketPath:string,body:unknown){
 return new Promise<{status:number;text:string}>((resolve,reject)=>{
  const outgoing=request({socketPath,path:'/commands',method:'POST'},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode!,text}));});
  outgoing.on('error',reject);outgoing.end(JSON.stringify(body));
 });
}
it('derives terminal sessions server-side and binds receipt identity to the explicit session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hq-terminal-sessions-'));const seen:ManagedCommandInput[]=[];
 const service=await startManagedService({directory:dir,databasePath:join(dir,'db.sqlite'),port:0,owner:{slackUserId:'owner',telegramUserId:'42'},execute:async input=>{seen.push(input);return {text:'accepted'};},getJob:()=>undefined,channelFactory:()=>({start:async()=>{},stop:async()=>{},send:async()=>{},status:()=>({slack:true,telegram:true})})});
 const socketPath=join(dir,'control.sock');const base={id:'first',text:'질문',source:'terminal',userId:'local'};
 try{
  expect((await terminalCall(socketPath,base)).status).toBe(200);
  expect((await terminalCall(socketPath,base)).status).toBe(200);
  expect((await terminalCall(socketPath,{...base,id:'second',sessionId:'a'})).status).toBe(200);
  expect((await terminalCall(socketPath,{...base,id:'third',sessionId:'a'})).status).toBe(200);
  expect((await terminalCall(socketPath,{...base,id:'fourth',sessionId:'b'})).status).toBe(200);
  expect((await terminalCall(socketPath,{...base,id:'second',sessionId:'b'})).status).toBe(400);
  expect(seen.map(input=>input.conversationId)).toEqual(['["terminal","local","default"]','["terminal","local","a"]','["terminal","local","a"]','["terminal","local","b"]']);
 }finally{await service.stop();await rm(dir,{recursive:true,force:true});}
});
it('separates channel, owner, destination and thread conversations while retaining the same thread',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hq-channel-sessions-'));const seen:ManagedCommandInput[]=[];let receive!:(input:LocalTextMessage)=>Promise<void>;
 const service=await startManagedService({directory:dir,databasePath:join(dir,'db.sqlite'),port:0,owner:{slackUserId:'owner',telegramUserId:'42'},execute:async input=>{seen.push(input);return {text:'accepted'};},getJob:()=>undefined,channelFactory:ports=>{receive=ports.onMessage;return {start:async()=>{},stop:async()=>{},send:async()=>{},status:()=>({slack:true,telegram:true})};}});
 try{
  await receive({...message('owner','a'),threadId:'thread1'});
  await receive({...message('owner','b'),threadId:'thread1'});
  await receive({...message('owner','c'),threadId:'thread2'});
  await receive({...message('owner','d'),destination:'C2',threadId:'thread1'});
  await receive({...message('42','e'),channel:'telegram',destination:'C1',threadId:'thread1'});
  await receive({...message('stranger','f'),threadId:'thread1'});
  await vi.waitFor(()=>expect(seen).toHaveLength(5),{timeout:2500});
  expect(seen.map(input=>input.conversationId)).toEqual(['["slack","owner","C1","thread1"]','["slack","owner","C1","thread1"]','["slack","owner","C1","thread2"]','["slack","owner","C2","thread1"]','["telegram","42","C1","thread1"]']);
 }finally{await service.stop();await rm(dir,{recursive:true,force:true});}
});
