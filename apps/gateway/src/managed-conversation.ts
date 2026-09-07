import {mkdirSync,chmodSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {openDatabase} from '@orca-hq/persistence';
import {z} from 'zod';
import type {ManagedCommandInput,ManagedCommandResult,ManagedCommandPorts,CommandProject} from './managed-commands.js';
import {redactRelayText} from './orca-relay.js';

const short=z.string().trim().min(1).max(4096);
const intent=z.enum(['run','status','review','select']);
export const ConversationDecision=z.discriminatedUnion('action',[
 z.object({action:z.literal('ask'),text:z.string().min(1).max(4000)}).strict(),
 z.object({action:z.literal('candidates'),projectIds:z.array(short).min(1).max(8),intent,requestMode:z.enum(['preserve','replace']).optional()}).strict(),
 z.object({action:z.literal('use'),projectId:short,intent,requestMode:z.enum(['preserve','replace']).optional()}).strict(),
 z.object({action:z.literal('search'),root:short,query:z.string().max(100)}).strict(),
 z.object({action:z.literal('propose'),mode:z.enum(['register','create']),path:short,summary:z.string().max(2000)}).strict(),
 z.object({action:z.literal('followup')}).strict()
]);
type Intent=z.infer<typeof intent>;
type Pending={kind:'projects';ids:string[];prompt:string;intent:Intent}|{kind:'locations';paths:string[]}|{kind:'proposal';mode:'register'|'create';path:string;summary:string};
export interface ConversationState {projectId?:string;projectPath?:string;jobId?:string;pending?:Pending;history:Array<{role:'user'|'assistant';text:string}>}
export interface ConversationContext {text:string;projects:Array<Pick<CommandProject,'id'|'name'|'absolutePath'|'aliases'|'enabled'>>;state:ConversationState}
export interface ConversationOptions {
 directory:string;catalog:ManagedCommandPorts['catalog'];execute(input:ManagedCommandInput):Promise<ManagedCommandResult>;
 interpret(context:ConversationContext):Promise<unknown>;
 locations:{search(root:string,query:string):Promise<{paths:string[];truncated:boolean}>;create(path:string):Promise<string>};
}
const confirmation=/^(?:확인|응|네|예|좋아|진행해|진행해줘|등록해줘|생성해줘|yes|ok)[.!\s]*$/iu;
const cancelled=/^(?:취소|그만|새 대화|프로젝트 바꾸기|\/new|\/cancel)[.!\s]*$/u;
function number(text:string):number|undefined {const m=text.match(/^\s*(\d+)(?:번)?(?:으로)?(?:\s*(?:할게|해줘|선택))?[.!\s]*$/u);return m?Number(m[1])-1:undefined;}
function exact(project:CommandProject,text:string){return [project.id,project.name,...project.aliases].some(v=>text===v||text.startsWith(v+' ')||text.startsWith(v+'에서 ')||text.startsWith(v+'의 '));}
export function createManagedConversation(options:ConversationOptions){
 mkdirSync(options.directory,{recursive:true,mode:0o700});
 const path=join(options.directory,'conversations.sqlite');const db=openDatabase(path);chmodSync(path,0o600);
 db.exec('CREATE TABLE IF NOT EXISTS hq_conversations(id TEXT PRIMARY KEY,state TEXT NOT NULL)');
 let closed=false;
 const save=(id:string,state:ConversationState)=>db.prepare('INSERT INTO hq_conversations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(id,JSON.stringify(state));
 return {close(){if(!closed){closed=true;db.close();}},async execute(input:ManagedCommandInput):Promise<ManagedCommandResult>{
  const text=z.string().trim().min(1).max(8000).parse(input.text);
  const key=input.conversationId??JSON.stringify([input.source,input.userId,input.sessionId??'default']);
  const row=db.prepare('SELECT state FROM hq_conversations WHERE id=?').get(key) as {state:string}|undefined;
  const state:ConversationState=row?JSON.parse(row.state):{history:[]};
  const answer=(result:ManagedCommandResult)=>{state.history.push({role:'user',text:redactRelayText(text)},{role:'assistant',text:redactRelayText(result.text).slice(0,3000)});state.history=state.history.slice(-12);save(key,state);return result;};
  if(state.pending?.kind==='proposal'&&!confirmation.test(text)){delete state.pending;save(key,state);}
  if(cancelled.test(text)){save(key,{history:[]});return {text:'대화의 프로젝트 선택과 대기 중 요청을 초기화했습니다. 어떤 프로젝트로 무엇을 할까요? 실행 중인 Orca 작업은 계속됩니다.'};}
  if(/^\/(?:start|help)(?:@\w+)?$/u.test(text)||text==='도움말')return answer({text:'프로젝트 이름을 몰라도 설명해 주세요. 예: 지하철 앱 로그인 고쳐줘 / 기존 프로젝트 폴더 찾아보자 / 새 앱을 만들고 싶어. 후보는 번호로 선택하고, 등록·생성은 경로를 확인한 뒤 진행합니다. 취소 또는 /new로 새 대화를 시작합니다. 터미널: hq chat 또는 hq ask --session 이름 "질문".'});
  const projects=await options.catalog.list();
  const project=(id:string)=>projects.find(p=>p.id===id);
  const dispatch=async(p:CommandProject,purpose:Intent,request:string)=>{
   if(!p.enabled)return answer({text:'HQ 사용에서 제외된 프로젝트입니다. 먼저 복원해주세요.'});
   if(state.projectId===p.id&&state.projectPath&&state.projectPath!==p.absolutePath){delete state.projectId;delete state.projectPath;delete state.jobId;delete state.pending;return answer({text:'프로젝트 경로가 변경되었습니다. 후보를 다시 확인하고 선택해주세요.'});}
   if(state.projectId!==p.id)delete state.jobId;
   state.projectId=p.id;state.projectPath=p.absolutePath;delete state.pending;save(key,state);
   if(purpose==='select')return answer({text:`${p.name} (${p.absolutePath})로 선택했습니다. 무엇을 할까요?`});
   const action=purpose==='run'?{action:'jobs.run',project:p.id,prompt:request}:purpose==='status'&&state.jobId?{action:'jobs.show',jobId:state.jobId}:{action:purpose==='review'?'projects.review':'projects.activity',project:p.id};
   const result=await options.execute({...input,text:'/hq '+JSON.stringify(action)});
   if(result.jobId)state.jobId=result.jobId;
   return answer(result);
  };
  const proposal=(mode:'register'|'create',target:string,summary:string)=>{
   if(!isAbsolute(target)||target.includes('\0'))return answer({text:'정확한 절대 경로를 알려주세요. 예: /Users/사용자/Project/my-app'});
   state.pending={kind:'proposal',mode,path:target,summary};
   return answer({text:`${mode==='create'?'새 프로젝트 생성':'Orca 프로젝트 등록'} 제안\n경로: ${target}\n${summary}\n${mode==='create'?'이 위치에 새 폴더와 Git 저장소, 초기 빈 커밋을 만듭니다. 기존 폴더는 덮어쓰지 않습니다. 실제 앱 개발은 등록 후 이어서 지시할 수 있습니다.':'기존 Git 저장소를 Orca에 등록합니다.'}\n이대로 진행할까요? 확인 또는 취소로 답하거나 변경할 내용을 말씀해 주세요.`});
  };
  const pick=number(text);
  if(state.pending?.kind==='projects'&&pick!==undefined){
   const pending=state.pending;const id=pending.ids[pick];const p=id?project(id):undefined;
   if(!p)return answer({text:'표시된 후보 번호를 선택해주세요. 후보가 사라졌다면 다시 찾아달라고 말씀해주세요.'});
   return dispatch(p,pending.intent,pending.prompt);
  }
  if(state.pending?.kind==='locations'&&pick!==undefined){const selected=state.pending.paths[pick];return selected?proposal('register',selected,'검색에서 발견한 기존 프로젝트입니다.'):answer({text:'표시된 경로 번호를 선택해주세요.'});}
  if(state.pending?.kind==='proposal'&&confirmation.test(text)){
   const pending=state.pending;delete state.pending;save(key,state);
   try{
    const target=pending.mode==='create'?await options.locations.create(pending.path):pending.path;
    const p=await options.catalog.add(target);state.projectId=p.id;state.projectPath=p.absolutePath;delete state.jobId;
    return answer({text:`${p.name}을 Orca에 등록하고 현재 대화의 프로젝트로 선택했습니다.\n경로: ${p.absolutePath}\n이제 만들 내용이나 수행할 작업을 말씀해 주세요.`});
   }catch{return answer({text:`${pending.path}의 ${pending.mode==='create'?'생성 또는 등록':'등록'}을 완료하지 못했습니다. 경로가 이미 있거나 Git 저장소가 아니거나 Orca가 응답하지 않았을 수 있습니다. 파일을 삭제하거나 자동 재실행하지 않았습니다. 현재 경로와 Orca 프로젝트 목록을 확인한 뒤 이어가겠습니다.`});}
  }
  // Explicit commands stay available; track their selected project so later natural language can continue.
  if(text.startsWith('/hq ')||/^(?:프로젝트\s*(?:목록|리스트|등록)|프로젝트 .+ (?:별칭|제외|복원)|작업 목록|작업 \S+ (?:상태|중지|재시도|이어서)|동기화)/u.test(text)){
   const result=await options.execute(input);
   if(result.projectId){const p=await options.catalog.resolve(result.projectId);if(state.projectId!==p.id)delete state.jobId;state.projectId=p.id;state.projectPath=p.absolutePath;}
   if(result.jobId)state.jobId=result.jobId;
   delete state.pending;
   return answer(result);
  }
  let decision:z.infer<typeof ConversationDecision>;
  try{decision=ConversationDecision.parse(await options.interpret({text:redactRelayText(text),projects:projects.map(({id,name,absolutePath,aliases,enabled})=>({id,name,absolutePath,aliases,enabled})),state}));}
  catch{return answer({text:'지금 AI가 요청을 확실하게 해석하지 못했습니다. 작업은 시작하지 않았습니다. 프로젝트 특징이나 원하는 작업을 조금 더 알려주세요. 프로젝트 목록 명령도 사용할 수 있습니다.'});}
  if(decision.action==='ask'){delete state.pending;return answer({text:redactRelayText(decision.text)});}
  if(decision.action==='propose')return proposal(decision.mode,decision.path,decision.summary);
  if(decision.action==='search'){
   try{const result=await options.locations.search(decision.root,decision.query);state.pending={kind:'locations',paths:result.paths};
    return answer({text:result.paths.length?`${decision.root} 범위에서 찾은 Git 프로젝트입니다. 등록할 경로를 번호로 선택해주세요.\n${result.paths.map((p,i)=>`${i+1}. ${p}`).join('\n')}${result.truncated?'\n탐색 제한에 도달했습니다. 더 좁은 위치를 알려주면 이어서 찾겠습니다.':''}`:`${decision.root}의 제한된 탐색 범위에서는 찾지 못했습니다. 다른 위치를 알려주시거나 새 프로젝트를 만들 위치와 목적을 함께 정해볼까요?`});
   }catch{return answer({text:'그 위치를 탐색할 수 없습니다. 접근 가능한 프로젝트 상위 폴더의 절대 경로를 알려주세요.'});}
  }
  if(decision.action==='followup'){
   const jobId=state.jobId;
   if(!jobId)return answer({text:'이 대화에 이어갈 작업이 아직 없습니다. 프로젝트나 작업 ID를 알려주세요.'});
   const result=await options.execute({...input,text:'/hq '+JSON.stringify({action:'jobs.followup',jobId,prompt:text})});if(result.jobId)state.jobId=result.jobId;return answer(result);
  }
  const ids=decision.action==='use'?[decision.projectId]:[...new Set(decision.projectIds)];
  const candidates=ids.map(project);
  if(candidates.some(p=>!p))return answer({text:'후보를 실제 Orca 프로젝트와 연결하지 못했습니다. 이름이나 위치 단서를 다시 확인해주세요.'});
  if(candidates.some(p=>!p!.enabled))return answer({text:'후보 중 HQ 사용에서 제외된 프로젝트가 있습니다. 프로젝트 목록에서 확인하고 먼저 복원해주세요.'});
  const previous=state.pending?.kind==='projects'?state.pending:undefined;
  const request=previous&&previous.intent===decision.intent&&decision.requestMode!=='replace'?`${previous.prompt}\n\n추가 설명·최신 지시 (이전 지시와 다르면 우선):\n${text}`:text;
  if(request.length>8000)return answer({text:'이어진 작업 요청이 너무 길어졌습니다. 취소 후 현재 원하는 작업을 한 번에 요약해주세요. 작업은 시작하지 않았습니다.'});
  if(decision.action==='use'){
   const p=candidates[0]!;
   // Never silently treat a model's fuzzy guess as the confirmed project.
   if(exact(p,text)||state.projectId===p.id||previous?.ids.includes(p.id))return dispatch(p,decision.intent,request);
  }
  state.pending={kind:'projects',ids,prompt:request,intent:decision.intent};
  return answer({text:`말씀하신 프로젝트 후보입니다. 어떤 것인지 번호나 이름으로 골라주세요.\n${candidates.map((p,i)=>`${i+1}. ${p!.name} — ${p!.absolutePath}`).join('\n')}\n없으면 위치 단서를 알려주시거나 새 프로젝트를 만들고 싶다고 말씀해주세요.`});
 }};
}
