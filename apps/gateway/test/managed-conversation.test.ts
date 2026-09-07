import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createManagedConversation} from '../src/managed-conversation.js';
import type {ManagedCommandInput,ManagedCommandResult,CommandProject} from '../src/managed-commands.js';
const dirs:string[]=[];const open:Array<()=>void>=[];
afterEach(async()=>{open.splice(0).forEach(close=>close());await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'hq-conversation-'));dirs.push(directory);
 const projects:CommandProject[]=['p1','p2'].map((id,i)=>({id,name:['subway-seet','subway-admin'][i]!,absolutePath:'/tmp/'+id,enabled:true,aliases:[],sensitivePaths:[],setupPolicy:'skip'}));
 const catalog={list:async()=>projects,resolve:async(id:string)=>{const p=projects.find(p=>p.id===id);if(!p)throw Error('missing');return p;},add:vi.fn(async(path:string)=>({...projects[0]!,absolutePath:path})),alias:async()=>{},setEnabled:async()=>{}};
 const calls:Array<ManagedCommandInput>=[];const execute=async(input:ManagedCommandInput):Promise<ManagedCommandResult>=>{calls.push(input);return {text:'전달 완료',jobId:'j1'};};
 const interpret=vi.fn(async(_context:unknown):Promise<unknown>=>({action:'candidates',projectIds:['p1','p2'],intent:'run'}));
 const locations={search:vi.fn(async()=>({paths:['/tmp/existing'],truncated:false})),create:vi.fn(async(path:string)=>path)};
 const options={directory,catalog,execute,interpret,locations};
 const make=()=>{const c=createManagedConversation(options);open.push(c.close);return c;};
 return {make,interpret,calls,catalog,locations,projects,options};
}
let n=0;const input=(text:string,conversationId='A'):ManagedCommandInput=>({id:'req'+(++n),text,conversationId,source:'terminal',userId:'local'});
describe('project conversation',()=>{
 it('asks for ambiguous candidates and preserves the actual request after numbered selection and restart',async()=>{
  const h=await fixture();let c=h.make();const answer=await c.execute(input('지하철 앱 로그인 수정해줘'));
  expect(answer.text).toContain('1. subway-seet');expect(h.calls).toHaveLength(0);c.close();open.pop();c=h.make();
  await c.execute(input('2번'));expect(JSON.parse(h.calls[0]!.text.slice(4))).toMatchObject({action:'jobs.run',project:'p2',prompt:'지하철 앱 로그인 수정해줘'});
 });
 it('isolates numbered selection between conversations and cancels without execution',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 앱 고쳐줘'));
  h.interpret.mockResolvedValue({action:'ask',text:'어떤 프로젝트인지 알려주세요.'});await c.execute(input('1','B'));expect(h.calls).toHaveLength(0);
  await c.execute(input('취소'));await c.execute(input('1'));expect(h.calls).toHaveLength(0);
 });
 it('rejects invented or disabled project IDs from AI before dispatch',async()=>{
  const h=await fixture();const c=h.make();h.interpret.mockResolvedValue({action:'use',projectId:'invented',intent:'run'});
  expect((await c.execute(input('고쳐줘'))).text).toContain('확인');expect(h.calls).toHaveLength(0);
  h.projects[0]={...h.projects[0]!,enabled:false};h.interpret.mockResolvedValue({action:'use',projectId:'p1',intent:'run'});
  expect((await c.execute(input('subway-seet 고쳐줘'))).text).toContain('제외');expect(h.calls).toHaveLength(0);
 });
 it('requires a visible path confirmation before creation and does not dispatch scaffolding implicitly',async()=>{
  const h=await fixture();const c=h.make();h.interpret.mockResolvedValue({action:'propose',mode:'create',path:'/tmp/new-app',summary:'가계부 앱'});
  const proposed=await c.execute(input('/tmp/new-app에 가계부 프로젝트 만들어줘'));
  expect(proposed.text).toContain('/tmp/new-app');expect(h.locations.create).not.toHaveBeenCalled();expect(h.catalog.add).not.toHaveBeenCalled();
  await c.execute(input('확인'));expect(h.locations.create).toHaveBeenCalledWith('/tmp/new-app');expect(h.catalog.add).toHaveBeenCalledWith('/tmp/new-app');expect(h.calls).toHaveLength(0);
 });
 it('turns actual filesystem matches into a registration proposal, with no registration before confirmation',async()=>{
  const h=await fixture();const c=h.make();h.interpret.mockResolvedValue({action:'search',root:'/tmp',query:'existing'});
  expect((await c.execute(input('/tmp에서 existing 찾아줘'))).text).toContain('/tmp/existing');
  await c.execute(input('1'));expect(h.catalog.add).not.toHaveBeenCalled();await c.execute(input('응'));expect(h.catalog.add).toHaveBeenCalledWith('/tmp/existing');
 });
 it('keeps the selected project for a later request but uses the native job for followup only',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 앱 고쳐줘'));await c.execute(input('1'));
  h.interpret.mockResolvedValue({action:'followup'});await c.execute(input('테스트도 실행해줘'));
  expect(JSON.parse(h.calls[1]!.text.slice(4))).toMatchObject({action:'jobs.followup',jobId:'j1',prompt:'테스트도 실행해줘'});
 });
 it('does not execute an old edit request when the user changes their mind to status during selection',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 앱 고쳐줘'));
  h.interpret.mockResolvedValue({action:'use',projectId:'p1',intent:'status'});
  await c.execute(input('첫번째, 수정하지 말고 상태만 알려줘'));
  expect(JSON.parse(h.calls[0]!.text.slice(4)).action).toBe('projects.activity');
 });
 it('preserves the initial task while narrowing an ambiguous candidate list',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 앱 로그인 고쳐줘'));
  h.interpret.mockResolvedValue({action:'candidates',projectIds:['p1'],intent:'run'});
  await c.execute(input('모바일 쪽이야'));await c.execute(input('1'));
  expect(JSON.parse(h.calls[0]!.text.slice(4)).prompt).toContain('지하철 앱 로그인 고쳐줘');
  expect(JSON.parse(h.calls[0]!.text.slice(4)).prompt).toContain('모바일 쪽이야');
 });
 it('invalidates a creation confirmation when an intervening question changes the conversation',async()=>{
  const h=await fixture();const c=h.make();h.interpret.mockResolvedValue({action:'propose',mode:'create',path:'/tmp/new-app',summary:'앱'});
  await c.execute(input('새 앱 만들어줘'));h.interpret.mockResolvedValue({action:'ask',text:'기존 프로젝트를 찾아볼까요?'});
  await c.execute(input('아니 기존에 있나 먼저 찾아보자'));await c.execute(input('네'));
  expect(h.locations.create).not.toHaveBeenCalled();expect(h.catalog.add).not.toHaveBeenCalled();
 });
 it('clears the old job when an explicit command selects a different project',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 앱 고쳐줘'));await c.execute(input('1'));
  h.options.execute=async()=>({text:'상태',projectId:'p2'});
  await c.execute(input('/hq {"action":"projects.activity","project":"p2"}'));
  h.interpret.mockResolvedValue({action:'followup'});
  expect((await c.execute(input('테스트도 해줘'))).text).toContain('이어갈 작업이 아직 없습니다');
 });
 it('does not resurrect a legacy thread job after /new',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 앱 고쳐줘'));await c.execute(input('1'));await c.execute(input('/new'));
  h.interpret.mockResolvedValue({action:'followup'});
  expect((await c.execute({...input('계속해줘'),contextJobId:'j1'})).text).toContain('이어갈 작업이 아직 없습니다');
  expect(h.calls).toHaveLength(1);
 });

 it('replaces a pending edit with the latest changed instruction instead of replaying the original edit',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 로그인 고쳐줘'));
  h.interpret.mockResolvedValue({action:'use',projectId:'p1',intent:'run',requestMode:'replace'});
  await c.execute(input('첫 번째인데 로그인은 놔두고 README만 고쳐줘'));
  expect(JSON.parse(h.calls[0]!.text.slice(4)).prompt).toBe('첫 번째인데 로그인은 놔두고 README만 고쳐줘');
 });
 it('does not interpret an answer to a new question as an old executable candidate number',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 고쳐줘'));
  h.interpret.mockResolvedValue({action:'ask',text:'새 프로젝트는 몇 명이 사용할까요?'});
  await c.execute(input('그 작업은 하지 말고 새 프로젝트부터 얘기하자'));await c.execute(input('1'));
  expect(h.calls).toHaveLength(0);
 });
 it('answers a known task progress question from the native job instead of the worktree card status',async()=>{
  const h=await fixture();const c=h.make();await c.execute(input('지하철 고쳐줘'));await c.execute(input('1'));
  h.interpret.mockResolvedValue({action:'use',projectId:'p1',intent:'status'});await c.execute(input('끝났어?'));
  expect(JSON.parse(h.calls[1]!.text.slice(4))).toEqual({action:'jobs.show',jobId:'j1'});
 });

});
