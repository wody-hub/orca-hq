import { chmod, mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { describe,it,expect } from 'vitest';
import { startManagedControl } from '../src/managed-control.js';
function call(path:string,body:unknown){return new Promise<{status:number,text:string}>((resolve,reject)=>{const r=request({socketPath:path,path:'/commands',method:'POST',headers:{'content-type':'application/json'}},s=>{let text='';s.on('data',c=>text+=c);s.on('end',()=>resolve({status:s.statusCode!,text}));});r.on('error',reject);r.end(JSON.stringify(body));});}
describe('managed control socket',()=>{
 it('accepts local commands through an owner-only socket and rejects forged channel identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hq-control-'));const path=join(dir,'control.sock');let count=0;
  const server=await startManagedControl({socketPath:path,execute:async()=>{count++;return {text:'accepted'};}});
  try{expect((await stat(path)).mode&0o777).toBe(0o600);
   expect((await call(path,{id:'r1',text:'프로젝트 목록',source:'terminal',userId:'local'})).status).toBe(200);
   expect((await call(path,{id:'r2',text:'run',source:'slack',userId:'other'})).status).toBe(400);expect(count).toBe(1);
  }finally{await server.stop();await rm(dir,{recursive:true,force:true});}
 });
 it('tightens an existing control directory before listening',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hq-control-mode-'));const dir=join(root,'open');await mkdir(dir);await chmod(dir,0o777);const path=join(dir,'control.sock');
  const server=await startManagedControl({socketPath:path,execute:async()=>({text:'accepted'})});
  try{expect((await stat(dir)).mode&0o777).toBe(0o700);expect((await stat(path)).mode&0o777).toBe(0o600);}
  finally{await server.stop();await rm(root,{recursive:true,force:true});}
 });
 it('rejects a symlinked control directory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hq-control-link-'));const real=join(root,'real');const linked=join(root,'linked');await mkdir(real);await symlink(real,linked,'dir');
  await expect(startManagedControl({socketPath:join(linked,'control.sock'),execute:async()=>({text:'accepted'})})).rejects.toThrow('control_directory_unavailable');
  await rm(root,{recursive:true,force:true});
 });
});

it('accepts only valid terminal session IDs and never client-supplied conversation or job context',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hq-control-session-'));const path=join(dir,'control.sock');const received:unknown[]=[];
 const server=await startManagedControl({socketPath:path,execute:async input=>{received.push(input);return {text:'accepted'};}});
 const base={id:'session-request',text:'질문',source:'terminal',userId:'local'};
 try{
  expect((await call(path,{...base,sessionId:'valid-session_1'})).status).toBe(200);
  expect(received).toEqual([{...base,sessionId:'valid-session_1'}]);
  for(const sessionId of ['', '../bad', 'two words', 'a'.repeat(101),'세션'])expect((await call(path,{...base,sessionId})).status).toBe(400);
  for(const extra of [{conversationId:'forged'},{contextJobId:'forged'}])expect((await call(path,{...base,...extra})).status).toBe(400);
  expect(received).toHaveLength(1);
 }finally{await server.stop();await rm(dir,{recursive:true,force:true});}
});
