import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const traceDir=mkdtempSync(join(tmpdir(),'tl-hook-diagnosis-'));
const trace=join(traceDir,'events.jsonl');
const preload=pathToFileURL(resolve('scripts/diagnose-windows-preload.mjs')).href;
const child=spawn(process.execPath,['scripts/run-product-ci-tests.mjs'],{
  stdio:'inherit',windowsHide:true,env:{...process.env,TL_WINDOWS_DIAG_TRACE:trace,PRODUCT_CI_TEST_SCOPE:'all',NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${preload}`.trim()}});
const timeout=setTimeout(()=>child.kill(),420000);
const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
clearTimeout(timeout);
if(existsSync(trace))console.log('FINAL_TRACE',readFileSync(trace,'utf8'));
rmSync(traceDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
console.log('DIAG_TEST_RESULT',JSON.stringify(result));
process.exitCode=result.code??1;
