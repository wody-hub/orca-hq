import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach,describe,it,expect} from 'vitest';
import {installGlobalCommand} from '../src/global-command.js';
const exec=promisify(execFile);const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const home=await mkdtemp(join(tmpdir(),'hq-global-'));dirs.push(home);const program=join(home,"program with ' quote");await mkdir(join(program,'packages/installer/bin'),{recursive:true});await writeFile(join(program,'packages/installer/bin/hq.js'),'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}))');return {home,program,node:process.execPath,shell:'/bin/zsh'};}
describe('global hq installation',()=>{
 it('runs the exact installed CLI from unrelated folders preserving quoted arguments and cwd',async()=>{const f=await fixture();const result=await installGlobalCommand(f);const r=await exec(result.path,['ask','a "b" $HOME'],{cwd:'/'});expect(JSON.parse(r.stdout)).toEqual({args:['ask','a "b" $HOME'],cwd:'/'});});
 it('is idempotent and adds a usable zsh PATH block without changing existing configuration',async()=>{const f=await fixture();await writeFile(join(f.home,'.zshrc'),'# existing\n');await installGlobalCommand(f);await installGlobalCommand(f);const rc=await readFile(join(f.home,'.zshrc'),'utf8');expect(rc.startsWith('# existing\n')).toBe(true);expect(rc.match(/# Orca HQ PATH/g)).toHaveLength(1);const result=await exec('/bin/zsh',['-ic','command -v hq'],{env:{HOME:f.home,ZDOTDIR:f.home,PATH:'/usr/bin:/bin'},cwd:'/'});expect(result.stdout.trim()).toBe(join(f.home,'.local/bin/hq'));});
 it('does not overwrite an unrelated command or a different HQ installation',async()=>{const f=await fixture();const path=join(f.home,'.local/bin/hq');await mkdir(join(f.home,'.local/bin'),{recursive:true});await writeFile(path,'#!/bin/sh\necho other\n');await expect(installGlobalCommand(f)).rejects.toThrow('기존');expect(await readFile(path,'utf8')).toContain('echo other');await rm(path);await installGlobalCommand(f);await expect(installGlobalCommand({...f,program:join(f.home,'other')})).rejects.toThrow();});
 it('refuses symlink launchers and preserves symlink shell configuration',async()=>{const f=await fixture();const existing=join(f.home,'existing');await writeFile(existing,'unchanged');await symlink(existing,join(f.home,'.zshrc'));await expect(installGlobalCommand(f)).rejects.toThrow('심볼릭');expect(await readFile(existing,'utf8')).toBe('unchanged');});
});
