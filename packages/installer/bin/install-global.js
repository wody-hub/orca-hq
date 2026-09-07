#!/usr/bin/env node
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {installGlobalCommand} from '../dist/global-command.js';

// CI and explicitly opted-out dependency installs must not alter a user's command environment.
if (!process.env.CI && process.env.ORCA_HQ_SKIP_GLOBAL_CLI !== '1') {
  try {
    const result=await installGlobalCommand({
      home:homedir(),program:fileURLToPath(new URL('../../..',import.meta.url)),
      node:process.execPath,shell:process.env.SHELL??'/bin/zsh',
      ...(process.env.ZDOTDIR?{zDotDirectory:process.env.ZDOTDIR}:{})
    });
    console.log(`전역 명령 등록: ${result.path}\n어느 폴더에서든 hq chat을 실행하세요. PATH가 없던 터미널은 새로 열어주세요.`);
  } catch(error) {
    console.error(`전역 hq 등록 실패: ${error instanceof Error?error.message:'경로를 확인해주세요.'}`);
    process.exitCode=error?.code==='HQ_GLOBAL_CONFLICT'?0:1;
  }
}
