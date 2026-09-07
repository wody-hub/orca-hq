import {constants} from 'node:fs';
import {access,chmod,lstat,mkdir,open,readFile,realpath} from 'node:fs/promises';
import {basename,isAbsolute,join} from 'node:path';

export interface GlobalCommandOptions {
  home:string;
  program:string;
  node:string;
  shell:string;
  zDotDirectory?:string;
}
const header='# Orca HQ managed launcher v1';
const pathBlock='\n# Orca HQ PATH\ncase ":$PATH:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin:$PATH" ;;\nesac\n';
const quote=(s:string)=>`'${s.replaceAll("'",`'"'"'`)}'`;
async function existingFile(path:string):Promise<string|undefined>{
  try{
    const stat=await lstat(path);
    if(stat.isSymbolicLink())throw Error(`심볼릭 링크를 변경하지 않습니다: ${path}`);
    if(!stat.isFile()||stat.uid!==process.getuid?.())throw Error(`기존 파일 소유권을 확인하세요: ${path}`);
    return await readFile(path,'utf8');
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
async function directory(path:string){
  try{await mkdir(path,{mode:0o755});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const stat=await lstat(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw Error(`사용자 디렉터리를 확인하세요: ${path}`);
}
/** User-level installation: no sudo, no pnpm lookup, no change of the caller's directory. */
export async function installGlobalCommand(options:GlobalCommandOptions):Promise<{path:string;profilePaths:string[]}>{
  if([options.home,options.program,options.node].some(p=>!isAbsolute(p)||/[\n\r\0]/u.test(p)))throw Error('설치 경로는 절대 경로여야 합니다.');
  const home=await realpath(options.home);
  const program=await realpath(options.program);
  const cli=join(program,'packages/installer/bin/hq.js');
  await access(cli,constants.R_OK);await access(options.node,constants.X_OK);
  const path=join(home,'.local/bin/hq');
  const marker=`${header}\n# program: ${JSON.stringify(program)}`;
  const old=await existingFile(path);
  if(old!==undefined&&!old.startsWith(`#!/bin/sh\n${marker}\n`))throw Object.assign(Error(`기존 hq 명령을 덮어쓰지 않습니다: ${path}`),{code:"HQ_GLOBAL_CONFLICT"});
  const shell=basename(options.shell);
  const profilePaths=shell==='zsh'
    ? ['.zprofile','.zshrc'].map(p=>join(options.zDotDirectory??home,p))
    : shell==='bash'?['.bash_profile','.bashrc'].map(p=>join(home,p)):[];
  if(profilePaths.length===0)throw Error('자동 PATH 등록은 zsh와 bash를 지원합니다.');
  const profiles=await Promise.all(profilePaths.map(async path=>({path,text:await existingFile(path)})));
  await directory(join(home,'.local'));await directory(join(home,'.local/bin'));
  const body=`#!/bin/sh\n${marker}\nexec ${quote(options.node)} ${quote(cli)} "$@"\n`;
  // NOFOLLOW keeps a replaced symlink from redirecting this write.
  const file=await open(path,old===undefined?constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL:constants.O_RDWR|constants.O_NOFOLLOW,0o755);
  try{
    if(old!==undefined){const current=await file.readFile('utf8');if(current!==old)throw Error('기존 hq가 변경됐습니다. 다시 확인하세요.');}
    await file.truncate(0);await file.write(body,0,'utf8');await file.chmod(0o755);
  }finally{await file.close();}
  for(const profile of profiles){
    if(profile.text?.includes('# Orca HQ PATH'))continue;
    const file=await open(profile.path,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o644);
    try{await file.writeFile(pathBlock);}finally{await file.close();}
  }
  await chmod(path,0o755);
  return {path,profilePaths};
}
