import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeTerminalRemoteControl, startClaudeTerminal, startWindowsClaudeWorker } from './claude-terminal.mjs';

test('terminal: explicit session, no daemon, no screen output, capability responses and observed exit', async () => {
  let data, exit, invocation;
  const writes=[];
  const terminal=await startClaudeTerminal(['--bg','--remote-control=continuation','--model','haiku','original prompt'], {
    sessionId:'a41a97ae-6b2a-421b-b2d5-1a0b07988d06',cwd:'/fixture',env:{PATH:'',CLAUDE_BG_BACKEND:'daemon',KEPT:'yes'},platform:'linux',
    loadPty:async()=>({spawn:(...args)=>{invocation=args;return {pid:123,onData:f=>{data=f},onExit:f=>{exit=f},write:s=>writes.push(s)}}}),
  });
  assert.equal(invocation[0],'claude');
  assert.equal(invocation[1].includes('--bg'),false);
  assert.deepEqual(invocation[1].slice(0,2),['--session-id','a41a97ae-6b2a-421b-b2d5-1a0b07988d06']);
  assert.equal(invocation[1].includes('--remote-control=continuation'),true);
  assert.equal(invocation[2].cwd,'/fixture');
  assert.equal(invocation[2].env.CLAUDE_BG_BACKEND,undefined);assert.equal(invocation[2].env.KEPT,'yes');
  data('\x1b[6n\x1b[c');assert.deepEqual(writes,['\x1b[1;1R','\x1b[?1;2c']);
  assert.equal(terminal.exit,null);exit({exitCode:7});assert.deepEqual(await terminal.ended,{exitCode:7});
  assert.equal(terminal.exit.exitCode,7);
});

test('WMI worker: preserve environment over stdin, never write secrets into code or process arguments', () => {
  const dir=mkdtempSync(join(tmpdir(),'tl-worker-bootstrap-'));
  try {
    let invocation;
    const pid=startWindowsClaudeWorker({sessionId:'fixture',cliPath:join(dir,'bin','throughline.mjs'),logPath:join(dir,'fixture.log'),
      nodePath:'C:\\Program Files\\nodejs\\node.exe',env:{PATH:'fixture-path',SECRET_TEST_VALUE:'private-sentinel'},
      spawn:(...args)=>{invocation=args;return {status:0,stdout:JSON.stringify({returnValue:0,pid:456})}}});
    assert.equal(pid,456);
    assert.equal(JSON.stringify(invocation.slice(0,2)).includes('private-sentinel'),false);
    const request=JSON.parse(invocation[2].input);
    assert.equal(request.cwd,dir,'a running worker must not pin the installation directory');
    assert.equal(request.environment.includes('SECRET_TEST_VALUE=private-sentinel'),true);
    const bootstrap=readdirSync(dir).find(f=>f.endsWith('.worker.mjs'));
    const code=readFileSync(join(dir,bootstrap),'utf8');assert.equal(code.includes('private-sentinel'),false);
    assert.match(code,/unlinkSync/);assert.match(code,/process.argv=/);
    const ps=Buffer.from(invocation[1].at(-1),'base64').toString('utf16le');
    assert.match(ps,/Win32_ProcessStartup/);assert.match(ps,/EnvironmentVariables/);assert.match(ps,/ShowWindow=\[uint16\]0/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('WMI worker: an uncertain response cannot release the source into a possible second execution', () => {
  const dir=mkdtempSync(join(tmpdir(),'tl-worker-uncertain-'));
  try {
    assert.throws(()=>startWindowsClaudeWorker({sessionId:'fixture',cliPath:join(dir,'cli.mjs'),logPath:join(dir,'f.log'),
      env:{},spawn:()=>({status:0,stdout:'not-json'})}),{code:'handoff_worker_start_unconfirmed'});
    assert.throws(()=>startWindowsClaudeWorker({sessionId:'fixture',cliPath:join(dir,'cli.mjs'),logPath:join(dir,'f.log'),
      env:{},spawn:()=>({status:null,error:{code:'ETIMEDOUT'}})}),{code:'handoff_worker_start_unconfirmed'});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('remote registration: use the exact session in the configured profile, never another session URL', () => {
  const dir=mkdtempSync(join(tmpdir(),'tl-terminal-registration-'));
  try {
    mkdirSync(join(dir,'sessions'));
    writeFileSync(join(dir,'sessions','1.json'),JSON.stringify({sessionId:'other',bridgeSessionId:'session_Other'}));
    writeFileSync(join(dir,'sessions','2.json'),'unfinished native metadata');
    assert.equal(readClaudeTerminalRemoteControl('requested',{env:{CLAUDE_CONFIG_DIR:dir}}),null);
    writeFileSync(join(dir,'sessions','3.json'),JSON.stringify({sessionId:'requested',bridgeSessionId:'session_Exact'}));
    assert.equal(readClaudeTerminalRemoteControl('requested',{env:{CLAUDE_CONFIG_DIR:dir}}),'https://claude.ai/code/session_Exact');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
