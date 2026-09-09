// Deterministic SDK wire peer. It is a fixture, never a model or a product runtime.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let cwd, model;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const notify=(method,params)=>send({jsonrpc:'2.0',method,params});
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);const response=result=>send({jsonrpc:'2.0',id:message.id,result});
 if(message.method==='initialize'){cwd=message.params.cwd;model=message.params.model;response({serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});}
 if(message.method==='shutdown'){response({});setTimeout(()=>process.exit(0),10);}
 if(message.method==='session/prompt'){
  const sessionId=message.params.sessionId;const input=message.params.contentBlocks.map(x=>x.text??'').join('');const messageId='fixture-message';response({messageId});
  const expectedModel=input.match(/FIXTURE_EXPECT_MODEL=([\w.-]+)/)?.[1];
  if(expectedModel && model!==expectedModel)throw new Error('Unexpected initialized model: '+model);
  if(input.includes('FIXTURE_EXPECT_WORKSPACE')){
   const workspace=JSON.parse(input.split('Execution workspace (controller-owned):\n')[1]?.split('\n')[0]??'null');
   if(workspace?.workingDirectory!==cwd || workspace?.primaryRepository===cwd)throw new Error('Assignment does not identify the actual SDK working directory separately from the primary repository');
  }
  setTimeout(()=>{
   const event=(type,data)=>notify('session.event',{sessionId,event:{type,data}});
   event('agent/inbox/spliced',{inserted:[{id:messageId}]});
   if(input.includes('FIXTURE_PROVIDER_ERROR')){
    event('turn/end',{reason:{kind:'error',error:{code:'TRANSPORT',message:'Provider connection failed'}}});
    notify('session.status',{sessionId,status:'idle'});return;
   }
   if(input.includes('FIXTURE_HANG')){spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();return;}
   writeFileSync(cwd+'/source.txt','implemented\n');
   const json=input.split('shape (no fences):\n')[1]?.split('\nUse outcome')[0];const delivery=JSON.parse(json);
   event('assistant/message',{message:{role:'assistant',content:[{type:'text',text:JSON.stringify(delivery)}]}});
   event('turn/end',{reason:{kind:'completed'}});
   notify('session.status',{sessionId,status:'idle'});
  },20);
 }
});
process.stdin.on('end',()=>process.exit(0));
