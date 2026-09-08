import { Controller, SdkRuntime } from '../../dist/index.js';
import { startHttp } from '../../dist/http.js';
import { resolve } from 'node:path';
const controller=new Controller({home:process.argv[2],runtime:new SdkRuntime(resolve('dist/runner.js')),dispatchEnabled:true,dshBin:resolve('tests/fixtures/runtime.mjs')});
const http=await startHttp(controller,{port:0,token:'a'.repeat(64),webDir:resolve('dist/web')});
process.send({url:http.url});
process.on('SIGTERM',async()=>{await http.close();await controller.close();process.exit(0);});
