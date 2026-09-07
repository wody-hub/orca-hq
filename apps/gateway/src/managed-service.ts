import { createServer } from 'node:http';
import { chmod } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { openDatabase } from '@orca-hq/persistence';
import { LocalTextStore,type LocalTextMessage } from './local-store.js';
import type { LocalChannelFactory } from './local-service.js';
import { formatManagedJob,type CommandJob,type ManagedCommandInput,type ManagedCommandResult } from './managed-commands.js';
import { ensureOwnerOnlyDirectory,startManagedControl } from './managed-control.js';

export interface ManagedServiceOptions {
 directory:string;databasePath:string;port?:number;owner:{slackUserId:string;telegramUserId:string};
 execute(input:ManagedCommandInput):Promise<ManagedCommandResult>;channelFactory:LocalChannelFactory;
 getJob(id:string):CommandJob|undefined;
 beforeReady?:()=>Promise<void>;
 initialCursors?:Partial<Record<'slack'|'telegram',string|number>>;
}
export async function startManagedService(options:ManagedServiceOptions){
 await ensureOwnerOnlyDirectory(dirname(options.databasePath));
 const db=openDatabase(options.databasePath);await chmod(options.databasePath,0o600);
 const inbox=new LocalTextStore(db);
 for(const channel of ['slack','telegram'] as const){const cursor=options.initialCursors?.[channel];if(cursor!==undefined&&inbox.loadCursor(channel)===undefined)inbox.saveCursor(channel,cursor);}
 db.exec(`CREATE TABLE IF NOT EXISTS managed_receipts(id TEXT PRIMARY KEY,input TEXT NOT NULL,response TEXT,state TEXT NOT NULL DEFAULT 'pending');
 CREATE TABLE IF NOT EXISTS managed_watchers(job_id TEXT NOT NULL,destination_key TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(job_id,destination_key));
 CREATE TABLE IF NOT EXISTS managed_outgoing(id TEXT PRIMARY KEY,message TEXT NOT NULL,text TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS managed_contexts(destination_key TEXT PRIMARY KEY,job_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS managed_job_snapshots(job_id TEXT PRIMARY KEY,updated_at TEXT NOT NULL,job_json TEXT NOT NULL);`);
 const receiptColumns=db.prepare('PRAGMA table_info(managed_receipts)').all() as Array<{name:string}>;
 if(!receiptColumns.some(column=>column.name==='state'))db.exec("ALTER TABLE managed_receipts ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'");
 const recoveryResponse=JSON.stringify({text:'이전 요청 처리 중 서비스가 중단되어 결과 확인 필요 상태입니다. 작업 목록과 프로젝트 상태를 확인한 뒤 새 요청 ID로 다시 지시해주세요.'} satisfies ManagedCommandResult);
 db.prepare("UPDATE managed_receipts SET response=?,state='completed' WHERE response IS NULL").run(recoveryResponse);
 db.prepare("UPDATE managed_receipts SET state='completed' WHERE response IS NOT NULL AND state<>'completed'").run();
 let stopping=false,ready=false,active:Promise<void>|undefined;let serial=Promise.resolve();
 const executeOnce=(input:ManagedCommandInput):Promise<ManagedCommandResult>=>{
  const operation=serial.then(async()=>{
   const encoded=JSON.stringify({id:input.id,text:input.text,source:input.source,userId:input.userId,...(input.sessionId===undefined?{}:{sessionId:input.sessionId})});const found=db.prepare('SELECT input,response,state FROM managed_receipts WHERE id=?').get(input.id) as {input:string;response:string|null;state:string}|undefined;
   if(found&&found.input!==encoded)throw new Error('request_identity_conflict');
   if(found?.response)return JSON.parse(found.response) as ManagedCommandResult;
   if(found?.state==='pending'){db.prepare("UPDATE managed_receipts SET response=?,state='completed' WHERE id=?").run(recoveryResponse,input.id);return JSON.parse(recoveryResponse) as ManagedCommandResult;}
   db.prepare("INSERT INTO managed_receipts(id,input,state) VALUES(?,?,'pending')").run(input.id,encoded);
   let result:ManagedCommandResult;
   try{result=await options.execute(input.source==='terminal'?{...input,conversationId:JSON.stringify(['terminal',input.userId,input.sessionId??'default'])}:input);}catch(e){
    const msg=e instanceof Error?e.message:'';
    result={text:/[가-힣]/u.test(msg)&&!/(?:https?:|xox[baprs]-|xapp-)/u.test(msg)?msg.slice(0,1000):'명령을 처리하지 못했습니다. 대상 프로젝트·작업 ID와 현재 상태를 확인해주세요.'};
   }
   db.prepare("UPDATE managed_receipts SET response=?,state='completed' WHERE id=?").run(JSON.stringify(result),input.id);return result;
  });serial=operation.then(()=>{},()=>{});return operation;
 };
 const channels=options.channelFactory({
  onMessage:async message=>{
   const expected=message.channel==='slack'?options.owner.slackUserId:options.owner.telegramUserId;
   if(stopping||message.userId!==expected)return;
   if(inbox.accept(message))schedule();
  },
  cursor:{load:c=>inbox.loadCursor(c),save:(c,v)=>inbox.saveCursor(c,v)}
 });
 const terminalStates=new Set(['succeeded','failed','stopped','recovery_required']);
 function currentJob(jobId:string):CommandJob|undefined{try{return options.getJob(jobId);}catch{return undefined;}}
 function snapshot(jobId:string):CommandJob|undefined{const row=db.prepare('SELECT job_json FROM managed_job_snapshots WHERE job_id=?').get(jobId) as {job_json:string}|undefined;return row===undefined?undefined:JSON.parse(row.job_json) as CommandJob;}
 function persistSnapshot(job:CommandJob):boolean{
  const current=db.prepare('SELECT updated_at FROM managed_job_snapshots WHERE job_id=?').get(job.id) as {updated_at:string}|undefined;
  if(current!==undefined&&current.updated_at>job.updatedAt)return false;
  db.prepare('INSERT INTO managed_job_snapshots(job_id,updated_at,job_json) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET updated_at=excluded.updated_at,job_json=excluded.job_json').run(job.id,job.updatedAt,JSON.stringify(job));return true;
 }
 function enqueue(job:CommandJob,watcher:{destination_key:string;message:string}):void{
  const key=JSON.stringify([job.id,job.state,job.updatedAt,watcher.destination_key]);
  db.prepare('INSERT OR IGNORE INTO managed_outgoing(id,message,text) VALUES(?,?,?)').run(key,watcher.message,formatManagedJob(job));
 }
 function persistAndEnqueue(job:CommandJob):void{db.transaction(()=>{if(!persistSnapshot(job))return;const watchers=db.prepare('SELECT destination_key,message FROM managed_watchers WHERE job_id=?').all(job.id) as Array<{destination_key:string;message:string}>;for(const watcher of watchers)enqueue(job,watcher);}).immediate();}
 function watch(jobId:string,message:LocalTextMessage){
  const key=[message.channel,message.destination,message.threadId??''].join(':');
  db.prepare('INSERT OR IGNORE INTO managed_watchers VALUES(?,?,?)').run(jobId,key,JSON.stringify(message));
  db.prepare('INSERT INTO managed_contexts VALUES(?,?) ON CONFLICT(destination_key) DO UPDATE SET job_id=excluded.job_id').run(key,jobId);
  const latest=currentJob(jobId)??snapshot(jobId);
  if(latest!==undefined&&terminalStates.has(latest.state))db.transaction(()=>{persistSnapshot(latest);enqueue(latest,{destination_key:key,message:JSON.stringify(message)});}).immediate();
 }
 async function drain(){
  while(!stopping){const work=inbox.claim(Date.now());if(!work)break;
   try{let text=work.response;if(text===undefined){const context=db.prepare('SELECT job_id FROM managed_contexts WHERE destination_key=?').get([work.message.channel,work.message.destination,work.message.threadId??''].join(':')) as {job_id:string}|undefined;let progressAt=0;const onProgress=async(text:string)=>{if(stopping||Date.now()-progressAt<15000)return;progressAt=Date.now();try{await channels.send(work.message,text);}catch{/* Intermediate delivery must not fail the command. */}};const result=await executeOnce({onProgress,id:work.message.id,text:work.message.text,source:work.message.channel,userId:work.message.userId,conversationId:JSON.stringify([work.message.channel,work.message.userId,work.message.destination,work.message.threadId??'']),...(context?{contextJobId:context.job_id}:{})});text=result.text;for(const jobId of new Set([...(result.jobIds??[]),...(result.jobId?[result.jobId]:[])]))watch(jobId,work.message);inbox.saveResponse(work.message.id,text);}
    await channels.send(work.message,text);inbox.delivered(work.message.id);
   }catch{inbox.retry(work.message.id,Date.now()+2000);}
  }
  const outgoing=db.prepare('SELECT id,message,text FROM managed_outgoing WHERE delivered=0 LIMIT 20').all() as Array<{id:string;message:string;text:string}>;
  for(const row of outgoing){if(stopping)break;try{await channels.send(JSON.parse(row.message) as LocalTextMessage,row.text);db.prepare('UPDATE managed_outgoing SET delivered=1 WHERE id=?').run(row.id);}catch{/* Persist for the next delivery attempt. */}}
 }
 function schedule(){if(stopping||!ready||active)return;active=drain().catch(()=>{}).finally(()=>{active=undefined;});}
 const server=createServer((req,res)=>{
  const status=channels.status();res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'&&req.url==='/health'){res.writeHead(ready?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify({service:'orca-hq',mode:'managed',state:ready?'running':'starting',pid:process.pid,channels:status,queue:inbox.summary()}));}
  else if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'"});res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><title>Orca HQ</title><h1>Orca HQ</h1><p>프로젝트 관리와 개발 작업은 Slack·Telegram 또는 터미널에서 지시하세요.</p><p>Slack: '+(status.slack?'연결':'연결 대기')+' / Telegram: '+(status.telegram?'연결':'연결 대기')+'</p></html>');}
  else{res.writeHead(404);res.end();}
 });
 let control:Awaited<ReturnType<typeof startManagedControl>>|undefined;
 let timer:ReturnType<typeof setInterval>|undefined;
 async function stop(){if(stopping)return;stopping=true;ready=false;if(timer)clearInterval(timer);await Promise.all([channels.stop(),control?.stop()]);await active;await serial;if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??4310,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  await options.beforeReady?.();
  control=await startManagedControl({socketPath:join(options.directory,'control.sock'),execute:executeOnce});
  inbox.recover();
  const watched=db.prepare('SELECT DISTINCT job_id FROM managed_watchers').all() as Array<{job_id:string}>;
  for(const row of watched){const latest=currentJob(row.job_id)??snapshot(row.job_id);if(latest!==undefined&&terminalStates.has(latest.state))persistAndEnqueue(latest);}
  await channels.start();ready=true;timer=setInterval(schedule,1000);schedule();
  const address=server.address();if(!address||typeof address==='string')throw new Error('listener_unavailable');
  return {port:address.port,stop,async notify(job:CommandJob){
   if(stopping)return;
   persistAndEnqueue(job);schedule();
  }};
 }catch(e){await stop();throw e;}
}
