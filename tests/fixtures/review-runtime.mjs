// Deterministic SDK wire peer, never a real model. Used for end-to-end control tests.
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
let cwd;
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const response=result=>send({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize'){cwd=m.params.cwd;response({serverInfo:{name:'deepseek-harness-sdk-runtime',version:'fixture'}});}
 if(m.method==='shutdown'){response({});setTimeout(()=>process.exit(0),10);}
 if(m.method!=='session/prompt')return;
 const {sessionId}=m.params;const input=m.params.contentBlocks.map(b=>b.text??'').join('');response({messageId:'review-fixture-message'});
 const notify=(method,params)=>send({jsonrpc:'2.0',method,params});
 const event=(type,data)=>notify('session.event',{sessionId,event:{type,data}});
 event('agent/inbox/spliced',{inserted:[{id:'review-fixture-message'}]});
 event('user/message',{id:'review-fixture-message',content:[{type:'text',text:input}]});
 notify('session.status',{sessionId,status:'running'});
 const reviewing=sessionId.startsWith('review-');
 if(reviewing){const file=input.split("Frozen evidence is at ")[1].split(". Read it")[0];if(JSON.parse(readFileSync(file,"utf8")).ticket.context.includes("E2E_STALL"))return;}
 setTimeout(()=>{
  const report=reviewing?JSON.parse(input.split('Return ONLY JSON matching this example: ')[1]):JSON.parse(input.split('shape (no fences):\n')[1].split('\nUse outcome')[0]);
  if(reviewing){if(readFileSync(join(cwd,'source.txt'),'utf8')!=='implemented\n')throw new Error('Review input not reconstructed');}
  else writeFileSync(join(cwd,'source.txt'),'implemented\n');
  event('assistant/message',{message:{role:'assistant',content:[{type:'text',text:JSON.stringify(report)}]}});
  event('turn/end',{reason:{kind:'completed'}});notify('session.status',{sessionId,status:'idle'});
 },reviewing?700:20);
});
process.stdin.on('end',()=>process.exit());
