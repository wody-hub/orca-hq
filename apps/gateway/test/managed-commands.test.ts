import { describe, it, expect, vi } from 'vitest';
import { createManagedCommands } from '../src/managed-commands.js';
function harness() {
 const project = {id:'p1',name:'subway-seet',absolutePath:'/tmp/demo',aliases:['subway-seet'],enabled:true,sensitivePaths:[],setupPolicy:'skip' as const};
 const catalog={list:vi.fn(async()=>[project]),resolve:vi.fn(async(_selector:string)=>project),add:vi.fn(async()=>project),alias:vi.fn(async()=>{}),setEnabled:vi.fn(async()=>{})};
 const job={id:'j1',projectId:'p1',projectName:'subway-seet',prompt:'fix',state:'queued',createdAt:'now',updatedAt:'now'};
 const jobs={list:()=>[job],get:()=>job,submit:vi.fn(async(_input:{requestId:string;prompt:string;project:unknown})=>job),stop:vi.fn(async()=>job),retry:vi.fn(async()=>job),followup:vi.fn(async()=>job)};
 const commands=createManagedCommands({catalog,jobs});
 return {commands,catalog,jobs};
}
const input=(text:string)=>({id:'request1',text,source:'terminal' as const,userId:'local'});
describe('managed commands',()=>{
 it('shows the newest twenty tasks regardless of native run ordering',async()=>{
  // Regression: slicing native run order omitted the task just submitted from Slack.
  const h=harness();const base=h.jobs.get();
  h.jobs.list=()=>Array.from({length:21},(_,i)=>({...base,id:`task-${21-i}`,createdAt:new Date(Date.UTC(2026,8,21-i)).toISOString()}));
  const result=await h.commands.execute(input('작업 목록'));
  expect(result.text).toContain('작업 task-21 ·');
  expect(result.text).toContain('작업 task-2 ·');
  expect(result.text).not.toContain('작업 task-1 ·');
  expect(result.text.indexOf('작업 task-21 ·')).toBeLessThan(result.text.indexOf('작업 task-2 ·'));
 });
 it('lists dynamically discovered projects without starting work',async()=>{
  const h=harness();expect((await h.commands.execute(input('프로젝트 목록 알려줘'))).text).toContain('subway-seet');expect(h.jobs.submit).not.toHaveBeenCalled();
 });
 it('routes Korean editing requests with an explicit project into actual jobs',async()=>{
  const h=harness();expect((await h.commands.execute(input('subway-seet 로그인 오류 고치고 테스트해줘'))).jobId).toBe('j1');expect(h.jobs.submit.mock.calls[0]?.[0]).toMatchObject({requestId:'request1',prompt:'subway-seet 로그인 오류 고치고 테스트해줘'});
 });
 it('routes a same-thread followup through its existing Orca task',async()=>{
  const h=harness();await h.commands.execute({...input('그 테스트도 확인해줘'),contextJobId:'j1'});
  expect(h.jobs.followup).toHaveBeenCalledWith('j1','그 테스트도 확인해줘','request1');expect(h.jobs.submit).not.toHaveBeenCalled();
 });
 it('requires a project for unscoped development instructions',async()=>{
  const h=harness();expect((await h.commands.execute(input('로그인 오류 고쳐줘'))).text).toContain('프로젝트');expect(h.jobs.submit).not.toHaveBeenCalled();
 });
 it('routes structured registration and control without executing them as a prompt',async()=>{
  const h=harness();await h.commands.execute(input('/hq '+JSON.stringify({action:'projects.add',path:'/tmp/demo'})));expect(h.catalog.add).toHaveBeenCalledWith('/tmp/demo');
  await h.commands.execute(input('/hq '+JSON.stringify({action:'jobs.stop',jobId:'j1'})));expect(h.jobs.stop).toHaveBeenCalledWith('j1');expect(h.jobs.submit).not.toHaveBeenCalled();
 });
 it('blocks retry and followup when a project has been excluded since its job finished',async()=>{
  const h=harness();const disabled={...(await h.catalog.resolve('p1')),enabled:false};h.catalog.resolve.mockResolvedValue(disabled);
  await expect(h.commands.execute(input('/hq '+JSON.stringify({action:'jobs.retry',jobId:'j1'})))).rejects.toThrow('제외');
  await expect(h.commands.execute(input('/hq '+JSON.stringify({action:'jobs.followup',jobId:'j1',prompt:'continue'})))).rejects.toThrow('제외');
  expect(h.jobs.retry).not.toHaveBeenCalled();expect(h.jobs.followup).not.toHaveBeenCalled();
 });
 it('rejects malformed structured commands before side effects',async()=>{
  const h=harness();await expect(h.commands.execute(input('/hq {"action":"projects.add"}'))).rejects.toThrow();expect(h.catalog.add).not.toHaveBeenCalled();expect(h.jobs.submit).not.toHaveBeenCalled();
 });
});
