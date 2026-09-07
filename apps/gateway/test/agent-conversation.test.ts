import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {openDatabase} from '@orca-hq/persistence';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createAgentConversation,type AgentSessionRunner} from '../src/agent-conversation.js';
import type {ManagedCommandInput} from '../src/managed-commands.js';
const roots:string[]=[];const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const c of closers.splice(0))await c();for(const d of roots.splice(0))await rm(d,{recursive:true,force:true});});
let sequence=0;
const input=(text:string,conversationId='slack-thread'):ManagedCommandInput=>({id:'request-'+(++sequence),text,source:'slack',userId:'owner',conversationId});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'hq-agent-test-'));roots.push(directory);
 const run=vi.fn<AgentSessionRunner['run']>(async p=>{await p.onThread(p.threadId??'thread-'+sequence);return {threadId:p.threadId??'thread-'+sequence,text:'조회한 작업 내용을 설명합니다.'};});
 const tools={specs:[],call:vi.fn(async(_name:string,_args:unknown,_input:ManagedCommandInput):Promise<unknown>=>({text:'실제 조회 결과'}))};
 const confirm=vi.fn(async()=>({text:'등록 완료',projectId:'created'}));
 const make=()=>{const c=createAgentConversation({directory,client:{run,close:async()=>{}},tools,confirmProject:confirm});closers.push(()=>c.close());return c;};
 return {directory,run,tools,confirm,make};
}
it('passes the full multi-project question to Codex and resumes the same thread across restart',async()=>{
 const f=await fixture();let c=f.make();const question='GH 1차와 scsms 프로젝트 조기경보체계 진행 상황 알려줘';
 expect((await c.execute(input(question))).text).toBe('조회한 작업 내용을 설명합니다.');
 expect(f.run.mock.calls[0]![0].text).toBe(question);
 const threadId=f.run.mock.calls[0]![0].threadId;expect(threadId).toBeUndefined();
 await c.close();c=f.make();await c.execute(input('아 GH workspace에서 법령 개정이력 작업 중일 거야'));
 expect(f.run.mock.calls[1]![0].threadId).toMatch(/^thread-/);
});
it('uses multiple tool results in one turn and collects every job watcher',async()=>{
 const f=await fixture();f.tools.call.mockImplementation(async(_n,args,request)=>({jobId:(args as {id:string}).id,text:request.id}));
 f.run.mockImplementation(async p=>{await p.onThread('t');await p.onTool('workspaces',{},'c1');await p.onTool('run',{id:'job-a'},'c2');await p.onTool('run',{id:'job-b'},'c3');return {threadId:'t',text:'두 작업을 Orca에 전달했습니다.'};});
 const r=await f.make().execute(input('두 프로젝트 고쳐줘'));expect(r.jobIds).toEqual(['job-a','job-b']);
 expect(new Set(f.tools.call.mock.calls.map(c=>c[2].id)).size).toBe(3);
});
it('isolates threads and /new clears session without resubmitting a legacy context job',async()=>{
 const f=await fixture();const c=f.make();await c.execute(input('GH 진행 알려줘','A'));await c.execute(input('안녕','B'));expect(f.run.mock.calls[1]![0].threadId).toBeUndefined();
 await c.execute(input('/new','A'));await c.execute({...input('계속 이야기하자','A'),contextJobId:'legacy'});expect(f.run.mock.calls[2]![0].threadId).toBeUndefined();expect(f.tools.call).not.toHaveBeenCalled();
});
it('persists a proposal and creates only after the next explicit confirmation',async()=>{
 const f=await fixture();f.tools.call.mockResolvedValue({proposal:{mode:'create',path:'/tmp/new-project',summary:'새 앱'}});
 f.run.mockImplementationOnce(async p=>{await p.onThread('t');await p.onTool('request_project',{},'c1');return {threadId:'t',text:'이 경로로 만들까요?'};});
 let c=f.make();const answer=await c.execute(input('새 앱 만들어줘'));expect(answer.text).toContain('/tmp/new-project');expect(f.confirm).not.toHaveBeenCalled();await c.close();c=f.make();await c.execute(input('확인'));expect(f.confirm).toHaveBeenCalledTimes(1);expect(f.run.mock.calls[1]![0].text).toContain('등록 완료');
});
it('invalidates a proposal when a different message intervenes',async()=>{
 const f=await fixture();f.tools.call.mockResolvedValue({proposal:{mode:'create',path:'/tmp/new-project',summary:'새 앱'}});
 f.run.mockImplementationOnce(async p=>{await p.onThread('t');await p.onTool('request_project',{},'c1');return {threadId:'t',text:'만들까요?'};});
 const c=f.make();await c.execute(input('새 앱'));await c.execute(input('그거 말고 기존 작업 조회해줘'));await c.execute(input('응'));expect(f.confirm).not.toHaveBeenCalled();
});
it('returns submitted job IDs even when Codex fails after mutation and does not replay it',async()=>{
 const f=await fixture();f.tools.call.mockResolvedValue({text:'실행 중',jobId:'job-a'});f.run.mockImplementation(async p=>{await p.onThread('t');await p.onTool('run',{},'c');throw new Error('codex_session_timeout');});
 const r=await f.make().execute(input('작업해줘'));expect(r.jobIds).toEqual(['job-a']);expect(r.text).toContain('시간');expect(f.tools.call).toHaveBeenCalledTimes(1);
});
it('deduplicates repeated dynamic call IDs and rejects changed arguments',async()=>{
 const f=await fixture();f.run.mockImplementation(async p=>{await p.onThread('t');await p.onTool('run',{a:1},'same');await p.onTool('run',{a:1},'same');await expect(p.onTool('run',{a:2},'same')).rejects.toThrow();return {threadId:'t',text:'완료'};});
 await f.make().execute(input('작업'));expect(f.tools.call).toHaveBeenCalledTimes(1);
});
it('serializes turns in one session so a followup cannot race thread creation',async()=>{
 const f=await fixture();let finish!:()=>void;const waiting=new Promise<void>(resolve=>finish=resolve);
 f.run.mockImplementationOnce(async p=>{await p.onThread('serial-thread');await waiting;return {threadId:'serial-thread',text:'첫 답변'};});
 const c=f.make();const first=c.execute(input('첫 질문'));const second=c.execute(input('후속 질문'));await vi.waitFor(()=>expect(f.run).toHaveBeenCalledTimes(1));finish();await Promise.all([first,second]);expect(f.run.mock.calls[1]![0].threadId).toBe('serial-thread');
});
it('does not repeat a successful mutation with a fresh call ID in the same request',async()=>{
 const f=await fixture();f.tools.call.mockResolvedValue({jobId:'job-a',text:'접수'});
 f.run.mockImplementation(async p=>{await p.onThread('t');await p.onTool('orca_execute',{action:'jobs.run',project:'gh',prompt:'고쳐줘'},'a');await p.onTool('orca_execute',{action:'jobs.run',project:'gh',prompt:'고쳐줘'},'b');return {threadId:'t',text:'접수했어요'};});
 await f.make().execute(input('고쳐줘'));expect(f.tools.call).toHaveBeenCalledTimes(1);
});
it('blocks an uncertain mutation with a fresh call ID after restart even if the model completed its answer',async()=>{
 const f=await fixture();f.tools.call.mockRejectedValue(new Error('전달 결과 불명'));
 f.run.mockImplementation(async p=>{await p.onThread('t');await expect(p.onTool('orca_execute',{action:'jobs.run',project:'gh',prompt:'고쳐줘'},'a-'+sequence)).rejects.toThrow();return {threadId:'t',text:'전달 상태를 확인하겠습니다.'};});
 let c=f.make();await c.execute(input('고쳐줘'));await c.close();c=f.make();await c.execute(input('어떻게 됐어?'));expect(f.tools.call).toHaveBeenCalledTimes(1);
});

it('migrates legacy context after a failed turn start and never resurrects it after /new',async()=>{
 const f=await fixture();const seed=openDatabase(join(f.directory,'conversations.sqlite'));seed.exec('CREATE TABLE hq_conversations(id TEXT PRIMARY KEY,state TEXT NOT NULL)');seed.prepare('INSERT INTO hq_conversations VALUES(?,?)').run('slack-thread',JSON.stringify({history:[{role:'user',text:'기억해야 할 이전 GH 요청'}]}));seed.close();
 f.run.mockImplementationOnce(async p=>{await p.onThread('t');throw Error('turn start failed');});
 const c=f.make();await c.execute(input('계속 확인'));await c.execute(input('다시 연결'));
 expect(f.run.mock.calls[1]![0].text).toContain('기억해야 할 이전 GH 요청');
 await c.execute(input('/new'));await c.execute(input('새 대화'));
 expect(f.run.mock.calls[2]![0].text).toBe('새 대화');expect(f.run.mock.calls[2]![0].threadId).toBeUndefined();
});
it('returns an effect cache result again for the same secondary call ID',async()=>{
 const f=await fixture();f.tools.call.mockResolvedValue({jobId:'a',text:'접수'});
 f.run.mockImplementation(async p=>{await p.onThread('t');const args={action:'jobs.run',project:'gh',prompt:'고쳐줘'};await p.onTool('orca_execute',args,'a');await p.onTool('orca_execute',args,'b');expect(await p.onTool('orca_execute',args,'b')).toMatchObject({jobId:'a'});return {threadId:'t',text:'접수'};});
 const result=await f.make().execute(input('고쳐줘'));expect(result.text).toBe('접수');expect(f.tools.call).toHaveBeenCalledTimes(1);
});
