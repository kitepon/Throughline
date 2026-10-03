import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = fs.realpathSync(process.argv[2]);
const mode = process.argv[3];
const steer = await import(pathToFileURL(path.join(root, 'deps/node_modules/aiterm-steer-delivery/dist/index.js')));
const binary = steer.findDesktopBinary();
const home = steer.realCodexHome();
process.env.CODEX_BIN = binary;
const profile = {
  id: 'throughline-auto-probe', display_name: 'Throughline自動継続試験',
  setup_command: '試験専用', codex_steer_command: '試験専用',
  mcp_server: 'throughline-auto-probe', dispatch_tools: [],
  state_root: () => path.join(root, 'delivery-state'),
  config_root: () => path.join(root, 'delivery-config'),
  hooks: { codex: 'probe-codex-hook.mjs', claude: 'probe-claude-hook.mjs', cursor: 'probe-cursor-hook.mjs' },
  codex_client_name: 'throughline_auto_continuation_probe',
  codex_hook_schema: 'throughline.auto-probe.v1', backup_suffix: '.probe-backup'
};
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const log = value => process.stdout.write(JSON.stringify(value) + '\n');
function connect() {
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, closed = false;
  const pending = new Map(), events = [];
  const exited = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  child.stderr.on('data', () => {});
  const fail = err => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('close', () => fail(new Error('試験用app-serverが終了しました')));
  child.stdin.on('error', fail);
  createInterface({ input: child.stdout }).on('line', line => {
    let row;
    try { row = JSON.parse(line); } catch { fail(new Error('試験用app-serverのJSONが不正です')); return; }
    const p = pending.get(row.id);
    if (p) {
      pending.delete(row.id); clearTimeout(p.timer);
      if (row.error) p.reject(new Error(JSON.stringify(row.error))); else p.resolve(row.result);
    } else if (row.method) events.push(row);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + 'の応答が確認できません')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  return {
    request, events, child,
    async initialize() {
      await request('initialize', { clientInfo: { name: 'throughline_auto_continuation_probe', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    },
    async close() {
      if (!closed) child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      const result = await exited;
      clearTimeout(timer); return result;
    }
  };
}

const project = path.join(root, 'integrated-clean');
const testHome = path.join(root, 'integrated-clean-home');
const repo = process.env.THROUGHLINE_PROBE_PRODUCT_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (mode === 'prepare') {
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.mkdirSync(testHome, { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# 自動引き継ぎの試験\n日本語で応答する。subagentを使わない。指定された試験ファイルだけを操作する。既存の成果物がある工程は再実行しない。\n');
  fs.writeFileSync(path.join(project, 'step.mjs'), `import fs from 'node:fs';
const stage=Number(process.argv[2]);const value=process.argv[3];
if(![1,2,3].includes(stage)||!value)throw Error('工程入力が不正です');
const old=fs.existsSync('progress.json')?JSON.parse(fs.readFileSync('progress.json','utf8')):{stage:0};
if(stage!==old.stage+1)throw Error('工程が重複または逆転しています');
for(let i=1;i<stage;i++){const p=JSON.parse(fs.readFileSync('stage-'+i+'.json','utf8'));if(p.inheritedValue!==value)throw Error('祖先の指示が失われました');}
fs.writeFileSync('stage-'+stage+'.json',JSON.stringify({stage,inheritedValue:value}));
fs.writeFileSync('progress.json',JSON.stringify({stage}));
console.log(JSON.stringify({stage,verified:true}));
`);
  const hook = path.join(root, 'integrated-clean-posttool.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';import {randomBytes} from 'node:crypto';
let raw='';for await(const c of process.stdin)raw+=c;const p=JSON.parse(raw);
const project=${JSON.stringify(project)};if(p.cwd!==project)throw Error('試験project不一致');
const progress=project+'/progress.json';const marker=project+'/injected-stage.json';
const stage=fs.existsSync(progress)?JSON.parse(fs.readFileSync(progress,'utf8')).stage:0;
const previous=fs.existsSync(marker)?JSON.parse(fs.readFileSync(marker,'utf8')).stage:0;
fs.appendFileSync(${JSON.stringify(path.join(root,'integrated-clean-hook-events.jsonl'))},JSON.stringify({at:Date.now(),event:p.hook_event_name,sessionId:p.session_id,turnId:p.turn_id,stage})+'\\n');
if(stage>previous&&stage<3){fs.writeFileSync(marker,JSON.stringify({stage}));process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'試験のtool結果です。この部分は作業に使いません。\\n'+randomBytes(80000).toString('hex')}}));}
else process.stdout.write('{}');
`);
  const q = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const preCommand = 'env HOME='+q(testHome)+' USERPROFILE='+q(testHome)+' CODEX_HOME='+q(home)+' '+
    [process.execPath,path.join(repo,'bin/throughline.mjs'),'codex-hook','pre-compact'].map(q).join(' ');
  const postCommand=[process.execPath,hook].map(q).join(' ');
  fs.writeFileSync(path.join(project,'.codex/hooks.json'),JSON.stringify({hooks:{
    PreCompact:[{matcher:'auto',hooks:[{type:'command',command:preCommand,timeout:30}]}],
    PostToolUse:[{hooks:[{type:'command',command:postCommand,timeout:10,additionalContextLimit:0}]}]
  }}));
  const rpc=connect();await rpc.initialize();
  try {
    const conf=await rpc.request('config/read',{includeLayers:false});
    const names=Object.keys(conf.config.mcp_servers??{});
    const initial=await rpc.request('hooks/list',{cwds:[project]});
    const foreign=initial.data.flatMap(x=>x.hooks).filter(h=>h.sourcePath!==path.join(project,'.codex/hooks.json'));
    let toml='model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nmodel_auto_compact_token_limit = 60000\n[features]\nhooks = true\n';
    for(const name of names)toml+='[mcp_servers.'+JSON.stringify(name)+']\nenabled = false\n';
    for(const h of foreign)toml+='[hooks.state.'+JSON.stringify(h.key)+']\nenabled = false\n';
    fs.writeFileSync(path.join(project,'.codex/config.toml'),toml);
    const configPath=path.join(home,'config.toml');const projectKey='projects.'+JSON.stringify(project)+'.trust_level';
    await rpc.request('config/batchWrite',{filePath:configPath,edits:[{keyPath:projectKey,value:'trusted',mergeStrategy:'replace'}]});
    const listed=await rpc.request('hooks/list',{cwds:[project]});
    const own=listed.data.flatMap(x=>x.hooks).filter(h=>h.sourcePath===path.join(project,'.codex/hooks.json'));
    if(own.length!==2)throw Error('試験hook数不一致');
    const keys=[...own.map(h=>'hooks.state.'+JSON.stringify(h.key)),'projects.'+JSON.stringify(project)];
    write('integrated-clean-config-edits.json',{configPath,keys});
    await rpc.request('config/batchWrite',{filePath:configPath,edits:own.flatMap(h=>[
      {keyPath:'hooks.state.'+JSON.stringify(h.key)+'.trusted_hash',value:h.currentHash,mergeStrategy:'replace'},
      {keyPath:'hooks.state.'+JSON.stringify(h.key)+'.enabled',value:true,mergeStrategy:'replace'}])});
    const start=await rpc.request('thread/start',{cwd:project,model:'gpt-6.1-sol',approvalPolicy:'never',sandbox:'danger-full-access'});
    await rpc.request('thread/inject_items',{threadId:start.thread.id,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'自動継続の統合試験です。依頼された工程を実行してください。'}]}]});
    await rpc.request('thread/name/set',{threadId:start.thread.id,name:'Throughline 自動継続の統合試験'});
    const nonce=randomUUID();
    write('integrated-clean-meta.json',{threadId:start.thread.id,project,testHome,nonce,createdAt:Date.now(),binary,codexHome:home});
    log({mode,threadId:start.thread.id,project,testHome,threshold:60000,nonce:'[試験値を保存済み]'});
  } finally{await rpc.close();}
} else if(mode==='submit') {
  const m=read('integrated-clean-meta.json');const parent={thread_id:m.threadId,codex_home:home};
  await steer.verifyCodexParent(profile,parent);
  const id=randomUUID();
  const text='自動引き継ぎの統合試験です。最初のsourceは codex:'+m.threadId+'。引き継ぎ後は最初に注入文の中断地点の取得コマンドを実行してL3を確認してください。最後の工程では最初のsourceのL3を取得し、工程1のtool入力と完了出力が読めたことをancestor-proof.jsonへ記録してください。継承値は '+m.nonce+'。step.mjsを読んで、node step.mjs 1 <継承値>、node step.mjs 2 <継承値>、node step.mjs 3 <継承値> の順に実行してください。各工程を別のtool呼出しで実行し、複数工程を一つのtoolへまとめないでください。切り替え後はprogress.jsonと既存stageファイルを確認して未完了の工程から再開してください。最後にstage-1.json、stage-2.json、stage-3.jsonの値が全て一致することを確認し、日本語で完了を報告してください。subagentを使わず、試験ファイルだけを操作してください。';
  write('integrated-clean-submission.json',{text,deliveryId:id,requestedAt:Date.now()});
  const receipt=await steer.submitCodexParentAnswer(profile,parent,id,text);
  write('integrated-clean-receipt.json',{...receipt,deliveryId:id,senderReturnedAt:Date.now()});log({mode,...receipt});
} else if(mode==='cleanup') {
  const edits=read('integrated-clean-config-edits.json');const rpc=connect();await rpc.initialize();
  try{await rpc.request('config/batchWrite',{filePath:edits.configPath,edits:edits.keys.map(keyPath=>({keyPath,value:null,mergeStrategy:'replace'}))});log({mode,removedOwnSections:edits.keys.length});}
  finally{await rpc.close();}
}
