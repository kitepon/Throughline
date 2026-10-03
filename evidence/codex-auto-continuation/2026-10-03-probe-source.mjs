// 実測に使った試験sourceの保存。製品CLIではない。実行前の設定backupと後片付けは実測記録を参照する。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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

if (mode === 'create-bc') {
  const project = path.join(root, 'bc');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# 試験専用\n日本語で応答する。依頼に書かれた試験ファイルだけを操作する。subagentを使わない。\n');
  const rpc = connect(); await rpc.initialize();
  try {
    const config = await rpc.request('config/read', { includeLayers: false });
    const names = Object.keys(config.config?.mcp_servers ?? {});
    const overrides = { 'model_reasoning_effort': 'high', 'features.hooks': false };
    for (const name of names) overrides['mcp_servers.' + name + '.enabled'] = false;
    const result = await rpc.request('thread/start', {
      cwd: project, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: 'workspace-write',
      config: overrides, serviceName: 'throughline-auto-probe'
    });
    const nonce = randomUUID();
    const memory = 'これは自動継続の試験用記憶。継承値は ' + nonce + '。作業は次のuser指示に従う。';
    await rpc.request('thread/inject_items', { threadId: result.thread.id, items: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: memory }] }
    ] });
    const meta = { threadId: result.thread.id, project, nonce, createdAt: Date.now(), binary, codexHome: home,
      model: result.model, effort: result.reasoningEffort, cwd: result.cwd, approvalPolicy: result.approvalPolicy,
      sandbox: result.sandbox, instructionSourceCount: result.instructionSources?.length ?? null,
      mcpDisabledCount: names.length };
    write('bc-meta.json', meta);
    log({ mode, ...meta, nonce: '[注入済みの試験値]' });
  } finally { await rpc.close(); }
} else if (mode === 'submit-bc') {
  const meta = read('bc-meta.json');
  const deliveryId = randomUUID();
  const parent = { thread_id: meta.threadId, codex_home: home };
  await steer.verifyCodexParent(profile, parent);
  const text = '注入された試験用記憶にある継承値を使って、このディレクトリへ bc-step-1.json を作成してください。JSONは inheritedValue と stage=1 を持つ。次に別のshell操作で5秒待ち、それから bc-step-2.json に同じ inheritedValue と stage=2 を書いてください。最後に bc-result.json を作り、両方のファイルを読んで一致したことを verified=true と記録してください。値を推測せず、試験ファイル以外は変更せず、subagentを使わないでください。';
  write('bc-submission.json', { deliveryId, requestedAt: Date.now(), threadId: meta.threadId });
  const receipt = await steer.submitCodexParentAnswer(profile, parent, deliveryId, text);
  write('bc-receipt.json', { ...receipt, deliveryId, senderReturnedAt: Date.now(), senderPid: process.pid });
  log({ mode, threadId: meta.threadId, deliveryId, ...receipt });
} else if (mode === 'observe-bc') {
  const meta = read('bc-meta.json');
  const receipt = fs.existsSync(path.join(root, 'bc-receipt.json')) ? read('bc-receipt.json') : null;
  const files = ['bc-step-1.json', 'bc-step-2.json', 'bc-result.json'].map(name => {
    const file = path.join(meta.project, name);
    if (!fs.existsSync(file)) return { name, exists: false };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { name, exists: true, mtimeMs: fs.statSync(file).mtimeMs,
      valueMatched: parsed.inheritedValue === meta.nonce, stage: parsed.stage, verified: parsed.verified };
  });
  const rpc = connect(); await rpc.initialize();
  try {
    const info = await rpc.request('thread/read', { threadId: meta.threadId, includeTurns: true });
    const queue = await rpc.request('thread/queue/list', { threadId: meta.threadId, limit: 10 });
    const turns = info.thread.turns.map(t => ({ id: t.id, status: t.status,
      itemTypes: t.items?.map(i => i.type), error: t.error?.message ?? null }));
    const result = { mode, threadId: meta.threadId, observedAt: Date.now(), receipt, files, turns,
      queue: queue.data.map(i => ({ id: i.id, status: i.status, clientUserMessageId: i.clientUserMessageId })),
      threadStatus: info.thread.status };
    write('bc-observation.json', result); log(result);
  } finally { await rpc.close(); }
} else if (mode === 'prepare-a') {
  const project = path.join(root, 'a');
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# 試験専用\n日本語で応答する。試験ファイルだけを操作する。subagentを使わない。\n');
  const hookFile = path.join(root, 'a-precompact-hook.mjs');
  const hookCode = [
    "import fs from 'node:fs';",
    "let text=''; for await (const chunk of process.stdin) text += chunk;",
    "const event = JSON.parse(text.replace(/^\\uFEFF/,''));",
    "if (event.cwd !== " + JSON.stringify(project) + ") throw new Error('試験projectが一致しません');",
    "fs.appendFileSync(" + JSON.stringify(path.join(root, 'a-hook-events.jsonl')) + ", JSON.stringify({at:Date.now(),event:event.hook_event_name,trigger:event.trigger,sessionId:event.session_id,turnId:event.turn_id})+'\\n');",
    "process.stdout.write(JSON.stringify({continue:false,stopReason:'Throughline試験: 自動圧縮前の停止を確認'})+'\\n');"
  ].join('\n');
  fs.writeFileSync(hookFile, hookCode, { mode: 0o600 });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = [process.execPath, hookFile].map(quote).join(' ');
  fs.writeFileSync(path.join(project, '.codex/hooks.json'), JSON.stringify({ hooks: {
    PreCompact: [{ matcher: 'auto', hooks: [{ type: 'command', command, timeout: 10 }] }]
  } }));
  const rpc = connect(); await rpc.initialize();
  try {
    const config = await rpc.request('config/read', { includeLayers: false });
    const names = Object.keys(config.config?.mcp_servers ?? {});
    const initial = await rpc.request('hooks/list', { cwds: [project] });
    const foreign = initial.data.flatMap(x => x.hooks).filter(h => h.sourcePath !== path.join(project, '.codex/hooks.json'));
    let toml = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nmodel_auto_compact_token_limit = 8192\n[features]\nhooks = true\n';
    for (const name of names) toml += '[mcp_servers.' + JSON.stringify(name) + ']\nenabled = false\n';
    for (const hook of foreign) toml += '[hooks.state.' + JSON.stringify(hook.key) + ']\nenabled = false\n';
    fs.writeFileSync(path.join(project, '.codex/config.toml'), toml, { mode: 0o600 });
    const filePath = path.join(home, 'config.toml');
    const projectKey = 'projects.' + JSON.stringify(project) + '.trust_level';
    write('a-config-edits.json', { filePath, keys: [projectKey], project });
    await rpc.request('config/batchWrite', { filePath, edits: [{ keyPath: projectKey, value: 'trusted', mergeStrategy: 'replace' }] });
    const listed = await rpc.request('hooks/list', { cwds: [project] });
    const own = listed.data.flatMap(x => x.hooks).filter(h => h.sourcePath === path.join(project, '.codex/hooks.json'));
    if (own.length !== 1) throw new Error('試験用PreCompact hookを正規に取得できません');
    const edits = own.flatMap(h => [
      { keyPath: 'hooks.state.' + JSON.stringify(h.key) + '.trusted_hash', value: h.currentHash, mergeStrategy: 'replace' },
      { keyPath: 'hooks.state.' + JSON.stringify(h.key) + '.enabled', value: true, mergeStrategy: 'replace' }
    ]);
    write('a-config-edits.json', { filePath, keys: [projectKey, ...edits.map(e => e.keyPath)], project });
    await rpc.request('config/batchWrite', { filePath, edits });
    const verified = await rpc.request('hooks/list', { cwds: [project] });
    const verifiedOwn = verified.data.flatMap(x => x.hooks).filter(h => h.sourcePath === path.join(project, '.codex/hooks.json'));
    if (verifiedOwn.some(h => h.trustStatus !== 'trusted' || !h.enabled)) throw new Error('試験用PreCompact hookの承認を確認できません');
    const start = await rpc.request('thread/start', { cwd: project, model: 'gpt-6.1-sol',
      approvalPolicy: 'never', sandbox: 'workspace-write', serviceName: 'throughline-auto-probe' });
    await rpc.request('thread/inject_items', { threadId: start.thread.id, items: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Throughline自動継続試験Aの準備済み記憶。次の指示に従い、試験ファイルだけを操作する。' }] }
    ] });
    const meta = { threadId: start.thread.id, project, binary, codexHome: home, createdAt: Date.now(),
      model: start.model, effort: start.reasoningEffort, approvalPolicy: start.approvalPolicy,
      threshold: 8192, hookKey: own[0].key, hookTrust: verifiedOwn[0].trustStatus,
      foreignHooksDisabled: foreign.length, mcpDisabledCount: names.length };
    write('a-meta.json', meta); log({ mode, ...meta });
  } finally { await rpc.close(); }
} else if (mode === 'submit-a') {
  const meta = read('a-meta.json');
  const parent = { thread_id: meta.threadId, codex_home: home };
  await steer.verifyCodexParent(profile, parent);
  const deliveryId = randomUUID();
  const text = '自動圧縮前の停止検証です。まず1回のshell操作で a-before.txt に「最初の操作完了」と書き、標準出力へその内容を返してください。その結果を確認した次のモデル応答で、別のshell操作を行い a-after.txt に「二番目の操作完了」と書いてください。二つの操作を同じtool実行へまとめず、並列実行もせず、試験ファイル以外を変更せず、subagentを使わないでください。';
  write('a-submission.json', { threadId: meta.threadId, deliveryId, requestedAt: Date.now() });
  const receipt = await steer.submitCodexParentAnswer(profile, parent, deliveryId, text);
  write('a-receipt.json', { deliveryId, ...receipt, senderReturnedAt: Date.now() });
  log({ mode, threadId: meta.threadId, deliveryId, ...receipt });
} else if (mode === 'observe-a') {
  const meta = read('a-meta.json');
  const rpc = connect(); await rpc.initialize();
  try {
    const info = await rpc.request('thread/read', { threadId: meta.threadId, includeTurns: true });
    const hooks = fs.existsSync(path.join(root, 'a-hook-events.jsonl'))
      ? fs.readFileSync(path.join(root, 'a-hook-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const result = { mode, observedAt: Date.now(), threadId: meta.threadId, hooks,
      files: ['a-before.txt', 'a-after.txt'].map(name => ({ name, exists: fs.existsSync(path.join(meta.project, name)) })),
      turns: info.thread.turns.map(t => ({ id: t.id, status: t.status, itemTypes: t.items?.map(i => i.type), error: t.error?.message ?? null })) };
    write('a-observation.json', result); log(result);
  } finally { await rpc.close(); }
} else if (mode === 'cleanup-a') {
  const own = read('a-config-edits.json');
  const rpc = connect(); await rpc.initialize();
  try {
    const meta = read('a-meta.json');
    const sections = ['projects.' + JSON.stringify(own.project), 'hooks.state.' + JSON.stringify(meta.hookKey)];
    await rpc.request('config/batchWrite', { filePath: own.filePath,
      edits: sections.map(keyPath => ({ keyPath, value: null, mergeStrategy: 'replace' })) });
    const after = await rpc.request('config/read', { includeLayers: false });
    const projectGone = !(own.project in (after.config?.projects ?? {}));
    const hookGone = !(meta.hookKey in (after.config?.hooks?.state ?? {}));
    if (!projectGone || !hookGone) throw new Error('試験設定の解除を確認できません');
    write('a-cleanup.json', { cleanedAt: Date.now(), projectGone, hookGone });
    log({ mode, removedOwnSections: sections.length, projectGone, hookGone });
  } finally { await rpc.close(); }

} else if (mode === 'inspect') {
  const rpc = connect(); await rpc.initialize();
  try {
    const models = await rpc.request('model/list', {});
    log({ binary, modelAvailable: models.data.some(m => m.model === 'gpt-6.1-sol' || m.id === 'gpt-6.1-sol') });
  } finally { await rpc.close(); }
} else throw new Error('未対応の試験モード');
