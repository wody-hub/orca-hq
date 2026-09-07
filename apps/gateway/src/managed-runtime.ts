import {readFile} from 'node:fs/promises';
import {openDatabase} from '@orca-hq/persistence';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {z} from 'zod';
import {parsePilotConfigText,pilotConfigurationPath} from '@orca-hq/core';
import {readLocalCredential} from './local-runtime.js';
import {createProjectCatalog} from './managed-projects.js';
import {createOrcaRelay} from './orca-relay.js';
import {createOrcaObserver} from './managed-observe.js';
import {createManagedCommands} from './managed-commands.js';
import {startManagedService} from './managed-service.js';
import {createLocalChannels} from './local-channels.js';
import {createManagedConversation} from './managed-conversation.js';
import {interpretConversation} from './conversation-ai.js';
import {createProjectLocations} from './project-locations.js';

export async function startManagedRuntime(){
 process.umask(0o077);
 const configPath=pilotConfigurationPath({homeDirectory:homedir(),configDirectory:process.env.XDG_CONFIG_HOME});
 const config=parsePilotConfigText(await readFile(configPath,'utf8'));const directory=dirname(configPath);
 const owner=z.object({slackUserId:z.string().regex(/^U[A-Z0-9]+$/),telegramUserId:z.string().regex(/^\d+$/)}).strict().parse(JSON.parse(await readFile(join(directory,'managed-owner.json'),'utf8')));
 const accounts=['slack-app-token','slack-bot-token','slack-channel-id','telegram-bot-token','telegram-allowed-chat-id'] as const;
 const values=await Promise.all(accounts.map(readLocalCredential));const credentials=Object.fromEntries(accounts.map((a,i)=>[a,values[i]!])) as Record<typeof accounts[number],string>;
 if(owner.telegramUserId!==credentials['telegram-allowed-chat-id'])throw new Error('managed_owner_mismatch');
 let service:Awaited<ReturnType<typeof startManagedService>>|undefined;
 const coordinator=z.object({coordinatorHandle:z.string().startsWith('term_')}).passthrough().parse(JSON.parse(await readFile(join(directory,'relay-coordinator.json'),'utf8')));
 const engine=createOrcaRelay({databasePath:join(directory,'orca-relay.sqlite'),coordinatorHandle:coordinator.coordinatorHandle,onUpdate:async job=>{await service?.notify(job);}});
 const catalog=createProjectCatalog({directory,legacyRegistryPath:config.projectRegistryPath,defaultSensitivePaths:['.env','.env.*','**/*.pem'],isBusy:id=>engine.isBusy(id)});
 const commands=createManagedCommands({catalog,jobs:engine,observe:(project,intent)=>createOrcaObserver().observe(project,intent)});
 const conversation=createManagedConversation({directory,catalog,execute:input=>commands.execute(input),interpret:interpretConversation,locations:createProjectLocations()});
 try{
  await catalog.list();
  const previous=openDatabase(config.databasePath);
  const initialCursors:Partial<Record<'slack'|'telegram',string|number>>={};
  try{if(previous.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_text_cursors'").get()){
   const rows=previous.prepare('SELECT channel,value_json FROM local_text_cursors').all() as Array<{channel:string;value_json:string}>;
   for(const row of rows)if(row.channel==='slack'||row.channel==='telegram')initialCursors[row.channel]=JSON.parse(row.value_json) as string|number;
  }}finally{previous.close();}
  service=await startManagedService({directory,databasePath:join(dirname(config.databasePath),'managed-control.sqlite'),initialCursors,owner,beforeReady:()=>engine.start(),getJob:id=>engine.getCached(id),execute:input=>conversation.execute(input),channelFactory:ports=>createLocalChannels({partialStart:true,
   slackAppToken:credentials['slack-app-token'],slackBotToken:credentials['slack-bot-token'],slackChannelId:credentials['slack-channel-id'],telegramBotToken:credentials['telegram-bot-token'],telegramChatId:credentials['telegram-allowed-chat-id'],...ports})});
  return {async stop(){await service?.stop();await engine.close();conversation.close();}};
 }catch(e){await service?.stop();await engine.close();conversation.close();throw e;}
}
