import { appendFileSync } from 'node:fs';
import workerThreads from 'node:worker_threads';
import Module from 'node:module';
const trace = (event, data = {}) => {
  if (process.env.TL_WINDOWS_DIAG_TRACE) appendFileSync(process.env.TL_WINDOWS_DIAG_TRACE, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, thread: workerThreads.threadId, event, ...data })+'\n');
};
trace('preload', { command: process.argv[2] ?? null });
process.on('uncaughtExceptionMonitor', error => trace('uncaught', { message: error.message, stack: error.stack }));
process.on('exit', code => trace('process-exit', { code }));
const OriginalWorker=workerThreads.Worker;
workerThreads.Worker=class extends OriginalWorker {
  constructor(file, options) {
    trace('worker-construct-before'); super(file,options); trace('worker-construct-after');
    this.on('online',()=>trace('worker-online'));
    this.on('message',message=>trace('worker-message',{message}));
    this.on('exit',code=>trace('worker-exit',{code}));
    // Monitor error emission without installing an error handler or suppressing failure.
  }
  emit(event,...args){if(event==='error')trace('worker-error',{message:args[0]?.message});return super.emit(event,...args);}
};
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
  const loaded=originalLoad.apply(this,arguments);
  if(typeof request!=='string'||!request.endsWith('conpty.node')) return loaded;
  return new Proxy(loaded,{get(target,key){
    const value=Reflect.get(target,key);
    if(!['startProcess','connect','kill'].includes(key)||typeof value!=='function')return value;
    return function(...args){
      trace('native-'+key+'-before');
      if(key==='connect'&&typeof args[5]==='function'){const callback=args[5];args[5]=code=>{trace('native-process-exit',{code});return callback(code);};}
      try{const result=value.apply(target,args);trace('native-'+key+'-after');return result;}
      catch(error){trace('native-'+key+'-error',{message:error.message});throw error;}
    };
  }});
};
