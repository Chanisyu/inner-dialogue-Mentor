/**
 * 完整历史回归使用合成分页、分段与父线程记录；不访问用户客户端，也不调用模型。
 * 覆盖游标终止、正文隔离、来源校验、收尾缩减保护及已有局部快照的受限修复。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import history from '../../hooks/codex-history.cjs';
import codex from '../../hooks/codex-transcript.cjs';
import archive from '../../hooks/transcript-archive.cjs';
import storage from '../../hooks/local-storage.cjs';

const ID = '40000000-0000-0000-0000-000000000001';
const ROOT_ID = '40000000-0000-0000-0000-000000000002';

/** 所有文件及清理范围限定为本测试创建的确切临时目录。 */
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'inner-dialogue-history-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); assert.ok(root.includes('inner-dialogue-history-')); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(join(root, '.therapy'));
  const file = join(root, 'rollout-last.jsonl');
  const user = (id, text) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] });
  const agent = (id, text) => ({ type: 'agentMessage', id, phase: 'final_answer', text });
  const first = { id: 'parent-turn', startedAt: 1000, items: [user('u0', '父线程保留内容'), agent('a0', '继承回应')] };
  const middle = { id: 'earlier-turn', startedAt: 1100, items: [user('u1', '前一分段的发言'), agent('a1', '前一分段的回答')] };
  const last = { id: 'last-turn', startedAt: 1200, items: [user('u2', '今天先到这里'), { ...agent('c2', '保存中'), phase: 'commentary' }] };
  const full = { thread: { id: ID, cwd: root }, turns: [first, middle, last] };
  const rows = [{ type: 'session_meta', ordinal: 8, payload: { id: ID, cwd: root, forked_from_id: ROOT_ID, forked_from_ordinal_exclusive: 4 } }, ...last.items.map((item, n) => ({ type: 'event_msg', ordinal: 9 + n, timestamp: '2026-11-01T01:00:00Z', payload: { type: 'item_completed', item: item.type === 'userMessage' ? { ...item, type: 'UserMessage' } : { ...item, type: 'AgentMessage', content: [{ type: 'Text', text: item.text }] } } }))];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { root, file, rows, full, last };
}

test('分页覆盖全部轮次，使用 full 视图并沿服务端游标读取，不恢复或发送消息', async () => {
  const calls = [];
  const result = await history.paginate(async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { thread: { id: ID, cwd: '/synthetic' } };
    return params.cursor ? { data: [{ id: 't2', items: [], itemsView: 'full' }], nextCursor: null } : { data: [{ id: 't1', items: [], itemsView: 'full' }], nextCursor: 'opaque' };
  }, ID);
  assert.equal(result.turns.length, 2);
  assert.deepEqual(calls.map(c => c[0]), ['thread/read', 'thread/turns/list', 'thread/turns/list']);
  assert.equal(calls[1][1].itemsView, 'full'); assert.equal(calls[2][1].cursor, 'opaque');
});

test('游标循环、缺少结束标记、重复轮次和摘要视图均拒绝，不能静默截断', async () => {
  for (const mode of ['cycle', 'missing', 'duplicate', 'summary']) {
    let n = 0;
    await assert.rejects(history.paginate(async method => {
      if (method === 'thread/read') return { thread: { id: ID, cwd: '/synthetic' } };
      n++;
      if (mode === 'missing') return { data: [] };
      return { data: [{ id: mode === 'duplicate' ? 'same' : String(n), items: [], itemsView: mode === 'summary' ? 'summary' : 'full' }], nextCursor: mode === 'summary' ? null : 'same-cursor' };
    }, ID));
  }
});

test('完整来源包含继承及前段正文，排除已撤回内容、工具和推理；校验当前分段', t => {
  const f = fixture(t), info = codex.source(f.file, ID);
  f.full.turns[0].items.push({ type: 'reasoning', id: 'secret', content: 'PRIVATE_REASONING' }, { type: 'commandExecution', id: 'tool', aggregatedOutput: 'PRIVATE_TOOL' });
  const result = codex.conversation(info, f.root, () => f.full);
  assert.deepEqual(result.messages.map(m => m.id), ['u0', 'a0', 'u1', 'a1', 'u2', 'c2']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.equal(result.messages[0].timestamp, '1970-01-01T00:16:40.000Z');
  assert.equal(result.messages[1].timestamp, null);
  for (const wrong of [() => { throw new Error('接口断开'); }, () => ({ ...f.full, thread: { id: ROOT_ID, cwd: f.root } }), () => ({ ...f.full, thread: { id: ID, cwd: join(f.root, 'other') } }), () => ({ ...f.full, turns: f.full.turns.slice(0, 1) })]) assert.throws(() => codex.conversation(info, f.root, wrong));
});

test('真正工作进程能使用只读分页协议，固定参数不经过命令行 shell', t => {
  const f = fixture(t);
  // 让 Node 执行临时的 app-server 脚本作为协议替身；生产代码没有测试专用开关。
  fs.writeFileSync(join(f.root, 'app-server'), `const readline=require('node:readline');const data=JSON.parse(process.env.SYNTHETIC_HISTORY);readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!r.id)return;let result;if(r.method==='initialize')result={};else if(r.method==='thread/read')result={thread:data.thread};else if(r.method==='thread/turns/list')result={data:data.turns,nextCursor:null};else process.exit(2);process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`);
  const script = resolve('hooks/codex-history.cjs');
  const out = spawnSync(process.execPath, [script, '--worker', ID], { cwd: f.root, encoding: 'utf8', timeout: 12000, windowsHide: true, env: { ...process.env, CODEX_APP_RUNTIME_CLI_PATH: process.execPath, SYNTHETIC_HISTORY: JSON.stringify(f.full) } });
  assert.equal(out.status, 0, out.stderr); assert.deepEqual(JSON.parse(out.stdout), f.full);
});

/** 已收尾快照使用真实的内容哈希目录，模拟旧版本只发布末段的结果。 */
function partial(f) {
  const id = codex.conversationId(ID), messages = codex.extract(f.rows);
  messages.push({ type: 'message', id: 'a2', role: 'assistant', timestamp: null, text: '最后回应', attachments: [] });
  const meta = { type: 'conversation', schema: 1, session_id: id, client: 'codex', native_session_id: ID, mode: 'counseling', settings: { mode: 'counseling' } };
  const raw = [meta, ...messages].map(r => JSON.stringify(r)).join('\n') + '\n';
  const hash = crypto.createHash('sha256').update(raw).digest('hex'), rel = 'transcripts/' + id + '/' + hash;
  storage.atomic(join(f.root, rel, 'conversation.jsonl'), raw);
  storage.atomic(join(f.root, rel, 'conversation.md'), archive.markdown(meta, messages));
  const entry = { session_id: id, client: 'codex', native_session_id: ID, mode: 'counseling', message_count: messages.length, jsonl: rel + '/conversation.jsonl', markdown: rel + '/conversation.md' };
  storage.json(join(f.root, 'transcripts/index.json'), { schema: 1, sessions: { [id]: entry } });
  storage.json(join(f.root, '.therapy/archive-state', id + '.json'), { schema: 1, session_id: id, client: 'codex', native_session_id: ID, transcript_path: f.file, last_archive: entry });
  return { id, entry, raw };
}

test('显式补归档扩展旧末段快照，保留旧文件；重复修复幂等，新增消息时拒绝', t => {
  const f = fixture(t); f.last.items.push({ type: 'agentMessage', id: 'a2', phase: 'final_answer', text: '最后回应' });
  const old = partial(f), original = history.read; history.read = () => f.full; t.after(() => { history.read = original; });
  const result = archive.repair(f.root, old.id);
  assert.equal(result.message_count, 7); assert.equal(result.previous_message_count, 3);
  assert.equal(fs.readFileSync(join(f.root, old.entry.jsonl), 'utf8'), old.raw);
  assert.equal(archive.repair(f.root, old.id).repeated, true);
  const index = fs.readFileSync(join(f.root, 'transcripts/index.json'));
  f.full.turns.push({ id: 'new-turn', items: [{ type: 'userMessage', id: 'new-user', content: [{ type: 'text', text: '后来新增的交流' }] }] });
  assert.throws(() => archive.repair(f.root, old.id), /已有新交流/);
  assert.deepEqual(fs.readFileSync(join(f.root, 'transcripts/index.json')), index);
});

test('主动收尾发布完整历史，接口缩减时保留旧索引及请求，不降级保存末段', t => {
  const f = fixture(t), id = codex.conversationId(ID), original = history.read;
  history.read = () => f.full; t.after(() => { history.read = original; });
  archive.runHook(f.root, { session_id: id, native_session_id: ID, client: 'codex', transcript_path: f.file, hook_event_name: 'UserPromptSubmit' });
  archive.request(f.root, id);
  const all = f.full.turns;
  f.full.turns = [f.last];
  assert.throws(() => archive.finish(f.root, { session_id: id, last_assistant_message: '最后回应' }), /范围缩小/);
  assert.equal(fs.existsSync(join(f.root, 'transcripts/index.json')), false);
  assert.ok(storage.read(join(f.root, '.therapy/archive-state', id + '.json')).pending);
  f.full.turns = all;
  const result = archive.finish(f.root, { session_id: id, last_assistant_message: '最后回应' });
  assert.equal(result.message_count, 7);
});
