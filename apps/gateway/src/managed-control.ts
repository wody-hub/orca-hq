import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ManagedCommandInput, ManagedCommandResult } from './managed-commands.js';
const InputSchema=z.object({id:z.string().min(1).max(512),text:z.string().min(1).max(8000),source:z.literal('terminal'),userId:z.literal('local'),sessionId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional()}).strict();
export async function ensureOwnerOnlyDirectory(path:string):Promise<void>{
 await mkdir(path,{recursive:true,mode:0o700});
 const before=await lstat(path);const uid=process.getuid?.();
 if(!before.isDirectory()||before.isSymbolicLink()||uid===undefined||before.uid!==uid)throw new Error('control_directory_unavailable');
 await chmod(path,0o700);
 const after=await lstat(path);
 if(!after.isDirectory()||after.isSymbolicLink()||after.uid!==uid||(after.mode&0o777)!==0o700)throw new Error('control_directory_unavailable');
}
async function removeStale(path:string):Promise<void>{
 try {const file=await lstat(path);if(!file.isSocket()||file.uid!==process.getuid?.())throw new Error('control_path_unavailable');}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 const stale=await new Promise<boolean>((resolve,reject)=>{const socket=createConnection(path);socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('timeout',()=>{socket.destroy();reject(new Error('control_socket_busy'));});socket.once('error',(e:NodeJS.ErrnoException)=>{socket.destroy();if(e.code==='ECONNREFUSED'||e.code==='ENOENT')resolve(true);else reject(new Error('control_socket_unavailable'));});});
 if(!stale)throw new Error('control_socket_busy');await unlink(path).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});
}
export async function startManagedControl(options:{socketPath:string;execute(input:ManagedCommandInput):Promise<ManagedCommandResult>}){
 await ensureOwnerOnlyDirectory(dirname(options.socketPath));
 await removeStale(options.socketPath);
 let accepting=false;
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  if(!accepting){res.writeHead(503);res.end('{}');return;}
  if(req.method!=='POST'||req.url!=='/commands'){res.writeHead(404);res.end('{}');return;}
  try {let body='';for await(const chunk of req){body+=String(chunk);if(Buffer.byteLength(body)>16384){res.writeHead(413);res.end('{}');return;}}
   const input=InputSchema.parse(JSON.parse(body));
   const {sessionId,...command}=input;const result=await options.execute(sessionId===undefined?command:{...command,sessionId});res.writeHead(200);res.end(JSON.stringify(result));
  }catch{res.writeHead(400);res.end(JSON.stringify({text:'명령을 처리하지 못했습니다. 입력과 HQ 로그를 확인하세요.'}));}
 });
 server.requestTimeout=10000;server.headersTimeout=5000;
 try{
  await new Promise<void>((resolve,reject)=>{const failed=(error:Error)=>reject(error);server.once('error',failed);const previous=process.umask(0o077);try{server.listen(options.socketPath,()=>{server.removeListener('error',failed);resolve();});}finally{process.umask(previous);}});
  await chmod(options.socketPath,0o600);const socket=await lstat(options.socketPath);const uid=process.getuid?.();
  if(!socket.isSocket()||uid===undefined||socket.uid!==uid||(socket.mode&0o777)!==0o600)throw new Error('control_path_unavailable');
  accepting=true;
 }catch(error){
  if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await unlink(options.socketPath).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});
  throw error;
 }
 return {async stop(){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await unlink(options.socketPath).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});}};
}
