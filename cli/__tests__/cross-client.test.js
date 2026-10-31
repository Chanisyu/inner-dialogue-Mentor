/**
 * 跨客户端回归全部使用临时咨询目录与合成正文；真实私人对话只由用户实际使用产生。
 * 覆盖模式隔离、格式边界、两客户端保存冲突、回滚、恢复与配置保留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { install } from '../install.js';
import { update } from '../update.js';
import { archivePlan, applyArchiving, mergeCodexHooks, CODEX_EVENTS } from '../lib/transcript-archiving.js';
import memory from '../../hooks/shared-memory.cjs';
import codex from '../../hooks/codex-transcript.cjs';
import runtime from '../../hooks/codex-runtime.cjs';
import modes from '../../hooks/session-mode.cjs';
import archive from '../../hooks/transcript-archive.cjs';
import storage from '../../hooks/local-storage.cjs';

const CLAUDE = '20000000-0000-0000-0000-000000000001';
const NATIVE = '20000000-0000-0000-0000-000000000002';
const OTHER = '20000000-0000-0000-0000-000000000003';

/** 递归清理前确认完整绝对路径属于本测试的系统临时根，避免影响真实 Sage。 */
function fixture(t) {
  const sandbox = fs.mkdtempSync(join(tmpdir(), 'inner-dialogue-cross-'));
  const root = join(sandbox, 'Sage'); fs.mkdirSync(join(root, '.therapy'), { recursive: true });
  fs.writeFileSync(join(root, 'profile.md'), '# 档案\n原有内容\n', 'utf8');
  t.after(() => { assert.ok(resolve(sandbox).startsWith(resolve(tmpdir()) + sep)); assert.ok(sandbox.includes('inner-dialogue-cross-')); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return { root, sandbox };
}
function register(root, id, client = 'claude-code') { memory.runHook(root, { session_id: id, client, hook_event_name: 'UserPromptSubmit' }); }
function draft(root, id, base, changes) {
  storage.json(base.draft, { schema: 1, base_token: base.base_token, changes });
  return () => memory.commit(root, id, base.draft);
}
function records(root, id = NATIVE) {
  return [
    { type: 'session_meta', payload: { id, cwd: root } },
    { type: 'event_msg', timestamp: '2026-10-30T10:00:00Z', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '今天先到这里。' }] } } },
  ];
}
async function installed(t, dualMode = false) {
  const f = fixture(t);
  await install({ path: f.root, name: 'Sage', persona: 'coach', structure: 'moderate', modalities: ['cbt'], dualMode, force: true });
  const source = join(f.sandbox, 'rollout-2026-' + NATIVE + '.jsonl'), rows = records(f.root);
  const flush = () => fs.writeFileSync(source, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); flush();
  const payload = event => ({ hook_event_name: event, session_id: NATIVE, transcript_path: source, cwd: f.root, turn_id: 'turn-1', prompt: '今天先到这里。' });
  return { ...f, source, rows, flush, payload, id: codex.conversationId(NATIVE) };
}

test('共享保存使用会话独立摘要并发布版本，提交重试不重复写入', t => {
  const f = fixture(t); register(f.root, CLAUDE);
  const base = memory.begin(f.root, CLAUDE);
  assert.ok(base.summary.endsWith('-' + CLAUDE + '.md'));
  const save = draft(f.root, CLAUDE, base, [{ path: 'profile.md', content: '# 档案\n原有内容\n新确认的事实\n' }, { path: base.summary, content: '# 会谈\n新的摘要\n' }]);
  const result = save();
  assert.equal(result.revision, 1); assert.equal(memory.revision(f.root).revision, 1);
  assert.ok(fs.readFileSync(join(f.root, 'profile.md'), 'utf8').includes('原有内容'));
  assert.equal(fs.existsSync(base.draft), false);
  assert.equal(save().repeated, true);
  assert.equal(memory.revision(f.root).revision, 1);
});

test('两个客户端从旧版本保存时第二份被拒绝，重读合并后同时保留两方信息', t => {
  const f = fixture(t), b = codex.conversationId(NATIVE); register(f.root, CLAUDE); register(f.root, b, 'codex');
  const aBase = memory.begin(f.root, CLAUDE), bBase = memory.begin(f.root, b);
  assert.notEqual(aBase.summary, bBase.summary);
  draft(f.root, CLAUDE, aBase, [{ path: 'profile.md', content: '原有内容\nClaude 新确认\n' }])();
  const stale = draft(f.root, b, bBase, [{ path: 'profile.md', content: '原有内容\nCodex 新确认\n' }]);
  assert.throws(stale, /共享资料已变化/);
  assert.ok(fs.existsSync(bBase.draft));
  assert.equal(fs.readFileSync(join(f.root, 'profile.md'), 'utf8'), '原有内容\nClaude 新确认\n');
  const fresh = memory.begin(f.root, b);
  draft(f.root, b, fresh, [{ path: 'profile.md', content: fs.readFileSync(join(f.root, 'profile.md'), 'utf8') + 'Codex 新确认\n' }])();
  assert.equal(memory.revision(f.root).revision, 2);
  assert.ok(fs.readFileSync(join(f.root, 'profile.md'), 'utf8').includes('Claude 新确认\nCodex 新确认'));
});

test('手动修改也使基线失效，不能仅凭未变的版本号覆盖外部修改', t => {
  const f = fixture(t); register(f.root, CLAUDE); const base = memory.begin(f.root, CLAUDE);
  fs.writeFileSync(join(f.root, 'profile.md'), '用户手动修改');
  assert.throws(draft(f.root, CLAUDE, base, [{ path: 'profile.md', content: '过时内容' }]), /共享资料已变化/);
  assert.equal(fs.readFileSync(join(f.root, 'profile.md'), 'utf8'), '用户手动修改');
});

test('新用户消息撤销未提交基线，不把前一轮候选稿用于新一轮保存', t => {
  const f = fixture(t); register(f.root, CLAUDE); const base = memory.begin(f.root, CLAUDE);
  const save = draft(f.root, CLAUDE, base, [{ path: 'profile.md', content: '旧稿' }]); register(f.root, CLAUDE);
  assert.throws(save, /基线失效/);
});

test('活跃写锁阻止并发保存和半完成资料读取，不删除其他进程的锁', t => {
  const f = fixture(t); register(f.root, CLAUDE);
  const lock = join(f.root, '.therapy/memory-write.lock'); storage.json(lock, { pid: process.pid, token: OTHER });
  assert.throws(() => memory.begin(f.root, CLAUDE), /其他客户端正在保存/);
  assert.ok(memory.denied(f.root, { tool_name: 'Read', tool_input: { file_path: join(f.root, 'profile.md') } }, CLAUDE));
  assert.ok(memory.denied(f.root, { tool_name: 'Bash', tool_input: { command: 'Get-Content profile.md' } }, CLAUDE));
  assert.equal(storage.read(lock).pid, process.pid);
});

test('多文件保存中途写入失败时回滚已写目标，不发布新版本，保留候选稿', t => {
  const f = fixture(t); register(f.root, CLAUDE); const base = memory.begin(f.root, CLAUDE);
  const before = fs.readFileSync(join(f.root, 'profile.md'), 'utf8');
  const save = draft(f.root, CLAUDE, base, [{ path: 'profile.md', content: '尚未完整提交' }, { path: base.summary, content: '摘要' }]);
  const rename = fs.renameSync; let failed = false;
  fs.renameSync = (from, to) => { if (!failed && to === join(f.root, base.summary)) { failed = true; throw Object.assign(new Error('模拟磁盘故障'), { code: 'EIO' }); } return rename(from, to); };
  try { assert.throws(save, /模拟磁盘故障/); } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(join(f.root, 'profile.md'), 'utf8'), before);
  assert.equal(fs.existsSync(join(f.root, base.summary)), false); assert.equal(memory.revision(f.root).revision, 0);
  assert.ok(fs.existsSync(base.draft)); assert.equal(fs.existsSync(join(f.root, '.therapy/memory-write.lock')), false);
});

test('崩溃遗留写锁仅在旧进程死亡后恢复，未提交事务回滚后重新取得基线', t => {
  const f = fixture(t); register(f.root, CLAUDE);
  storage.json(join(f.root, '.therapy/memory-write.lock'), { pid: 2147483647, token: OTHER });
  fs.writeFileSync(join(f.root, 'profile.md'), '中断留下的新内容');
  storage.json(join(f.root, '.therapy/memory-journal', OTHER + '.json'), { schema: 1, id: OTHER, session_id: CLAUDE, mode: 'counseling', changes: [{ path: 'profile.md', before: '旧档案', after_hash: storage.hash('中断留下的新内容') }] });
  const base = memory.begin(f.root, CLAUDE);
  assert.equal(base.revision, 0); assert.equal(fs.readFileSync(join(f.root, 'profile.md'), 'utf8'), '旧档案');
});

test('已发布但未确认的事务恢复时保留新内容，并补登记已提交结果', t => {
  const f = fixture(t); register(f.root, CLAUDE);
  const result = { commit_id: OTHER, revision: 1, files: ['profile.md'], base_token: NATIVE };
  storage.json(join(f.root, '.therapy/memory-write.lock'), { pid: 2147483647, token: OTHER });
  storage.json(join(f.root, '.therapy/shared-state.json'), { schema: 1, revision: 1, commit_id: OTHER });
  fs.writeFileSync(join(f.root, 'profile.md'), '已经发布的新内容');
  storage.json(join(f.root, '.therapy/memory-journal', OTHER + '.json'), { schema: 1, id: OTHER, session_id: CLAUDE, mode: 'counseling', result, changes: [{ path: 'profile.md', before: '旧内容', after_hash: storage.hash('已经发布的新内容') }] });
  const base = memory.begin(f.root, CLAUDE);
  assert.equal(base.revision, 1); assert.equal(fs.readFileSync(join(f.root, 'profile.md'), 'utf8'), '已经发布的新内容');
  assert.equal(storage.read(join(f.root, '.therapy/memory-state', CLAUDE + '.json')).last_commit.commit_id, OTHER);
});

/** 两个独立 Node 进程同时提交旧基线，只有一方成功；失败方候选稿保留且明确报告。 */
test('真实并发提交不会相互覆盖，失败方可以重新合并', async t => {
  const f = await installed(t), secondId = codex.conversationId(NATIVE);
  register(f.root, CLAUDE); register(f.root, secondId, 'codex');
  const a = memory.begin(f.root, CLAUDE), b = memory.begin(f.root, secondId);
  draft(f.root, CLAUDE, a, [{ path: 'profile.md', content: '并发客户端 A' }]);
  draft(f.root, secondId, b, [{ path: 'profile.md', content: '并发客户端 B' }]);
  const child = (id, file) => new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [join(f.root, '.therapy/hooks/shared-memory.cjs'), '--commit', '--session', id, '--draft', file], { cwd: f.sandbox, windowsHide: true });
    let output = ''; processChild.stdout.on('data', text => output += text);
    processChild.on('error', reject); processChild.on('close', code => resolve({ code, output, file }));
  });
  const results = await Promise.all([child(CLAUDE, a.draft), child(secondId, b.draft)]);
  assert.equal(results.filter(r => r.code === 0).length, 1);
  const failed = results.find(r => r.code !== 0);
  assert.equal(JSON.parse(failed.output).ok, false); assert.ok(fs.existsSync(failed.file));
  assert.equal(memory.revision(f.root).revision, 1);
  assert.ok(['并发客户端 A', '并发客户端 B'].includes(fs.readFileSync(join(f.root, 'profile.md'), 'utf8')));
});

test('目标限制阻止越界、跨会话摘要和直接改写共享数据，允许本会话候选稿', t => {
  const f = fixture(t); register(f.root, CLAUDE);
  for (const rel of ['../profile.md', '.therapy/persona.md', 'context/../profile.md', 'sessions/2026-10-30-' + OTHER + '.md']) {
    const base = memory.begin(f.root, CLAUDE); assert.throws(draft(f.root, CLAUDE, base, [{ path: rel, content: '错误目标' }]), /不允许/);
  }
  assert.ok(memory.denied(f.root, { tool_name: 'Write', tool_input: { file_path: join(f.root, 'profile.md') } }, CLAUDE));
  assert.ok(memory.denied(f.root, { tool_name: 'Bash', tool_input: { command: 'Set-Content profile.md overwritten' } }, CLAUDE));
  assert.equal(memory.denied(f.root, { tool_name: 'apply_patch', tool_input: { command: '*** Add File: .therapy/memory-drafts/' + CLAUDE + '/' + OTHER + '.json\n+{}' } }, CLAUDE), null);
});

test('Codex 完成事件保留正文与附件引用，模型请求、工具、推理和压缩替代内容不混入', t => {
  const f = fixture(t), rows = records(f.root);
  rows.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_INJECTED_REQUEST' }] } });
  rows.push({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', raw_content: 'PRIVATE_REASONING' } } });
  rows.push({ type: 'compacted', payload: { message: 'PRIVATE_COMPACTION_SUMMARY' } });
  rows.push({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', aggregated_output: 'PRIVATE_TOOL_OUTPUT' } } });
  rows.push({ type: 'event_msg', timestamp: '2026-10-30T10:01:00Z', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', phase: 'final_answer', content: [{ type: 'Text', text: '完整回应\n下一行' }] } } });
  rows[1].payload.item.content.push({ type: 'image', image_url: 'data:PRIVATE_BASE64' });
  rows.push(rows.at(-1));
  const extracted = codex.extract(rows);
  assert.deepEqual(extracted.map(m => m.text), ['今天先到这里。', '完整回应\n下一行']);
  assert.equal(extracted[0].attachments[0].reference, 'codex-item:u1:block:1');
  assert.ok(!JSON.stringify(extracted).includes('PRIVATE_'));
});

test('旧版 Codex 事件可以导出，无真实用户事件或未知正文块时拒绝猜测', t => {
  const f = fixture(t), head = records(f.root)[0];
  assert.deepEqual(codex.extract([head, { type: 'event_msg', payload: { type: 'user_message', message: '旧用户' } }, { type: 'event_msg', payload: { type: 'agent_message', message: '旧回应' } }]).map(m => m.text), ['旧用户', '旧回应']);
  assert.throws(() => codex.extract([head, { type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }]), /真实用户/);
  const rows = records(f.root); rows[1].payload.item.content.push({ type: 'unknown' });
  assert.throws(() => codex.extract(rows), /未知内容块/);
});

test('Codex 原生回滚去掉被撤回轮次，不把撤回回复混入新分支', t => {
  const f = fixture(t), rows = records(f.root);
  rows.push({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'old', content: [{ type: 'Text', text: '撤回的回答' }] } } });
  rows.push({ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } });
  rows.push({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'new', content: [{ type: 'text', text: '新的分支发言' }] } } });
  assert.deepEqual(codex.extract(rows).map(m => m.text), ['新的分支发言']);
});

test('Codex 身份恢复稳定，来源不匹配和其他咨询师目录被拒绝', async t => {
  const f = await installed(t);
  assert.equal(codex.normalize(f.payload('SessionStart'), f.root).session_id, f.id);
  assert.equal(codex.normalize(f.payload('SessionStart'), f.root).session_id, f.id);
  assert.notEqual(f.id, NATIVE); assert.notEqual(f.id, CLAUDE);
  assert.throws(() => codex.normalize({ ...f.payload('SessionStart'), session_id: OTHER }, f.root), /不一致/);
  assert.throws(() => codex.normalize(f.payload('SessionStart'), join(f.root, 'Elsewhere')), /不属于/);
});

test('Codex 钩子包含模式和共享规则，主动收尾保存最终回应，原有 Claude 模式不受影响', async t => {
  const f = await installed(t, true);
  modes.selectState(f.root, CLAUDE, { mode: 'counseling' }, 'explicit');
  const start = runtime.runHook(f.root, f.payload('SessionStart'));
  assert.ok(start.hookSpecificOutput.additionalContext.includes('INNER_DIALOGUE_PENDING'));
  modes.selectState(f.root, f.id, { mode: 'friend', persona: 'warm-talkative', length: 'standard' }, 'explicit');
  const prompt = runtime.runHook(f.root, f.payload('UserPromptSubmit'));
  assert.ok(prompt.hookSpecificOutput.additionalContext.includes('INNER_DIALOGUE_MEMORY'));
  assert.ok(prompt.hookSpecificOutput.additionalContext.includes('ARCHIVE_SESSION'));
  const safety = runtime.runHook(f.root, { ...f.payload('UserPromptSubmit'), prompt: '我想死' });
  assert.ok(safety.hookSpecificOutput.additionalContext.includes('AUTOMATED SAFETY NOTICE'));
  const base = memory.begin(f.root, f.id);
  draft(f.root, f.id, base, [{ path: base.summary, content: '# 朋友交流\n已确认的生活事件\n' }])();
  archive.request(f.root, f.id);
  runtime.runHook(f.root, { ...f.payload('Stop'), last_assistant_message: '最后的朋友回应。' });
  const entry = storage.read(join(f.root, 'transcripts/index.json')).sessions[f.id];
  const saved = fs.readFileSync(join(f.root, entry.jsonl), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(saved[0].client, 'codex'); assert.equal(saved[0].mode, 'friend');
  assert.equal(saved.at(-1).text, '最后的朋友回应。');
  assert.equal(modes.readState(f.root, CLAUDE).mode, 'counseling');
  assert.equal(modes.readState(f.root, f.id).mode, 'friend');
  assert.equal(storage.read(join(f.root, '.therapy/archive-state', f.id + '.json')).pending, undefined);
});

test('Codex 普通回应不归档，中断撤销请求，工具保护检查补丁和朋友临床资料读取', async t => {
  const f = await installed(t, true); runtime.runHook(f.root, f.payload('SessionStart'));
  modes.selectState(f.root, f.id, { mode: 'friend', persona: 'warm-talkative', length: 'concise' }, 'explicit');
  runtime.runHook(f.root, f.payload('UserPromptSubmit'));
  runtime.runHook(f.root, { ...f.payload('Stop'), last_assistant_message: '普通回应' });
  assert.equal(fs.existsSync(join(f.root, 'transcripts')), false);
  archive.request(f.root, f.id); runtime.runHook(f.root, f.payload('Interrupt'));
  runtime.runHook(f.root, { ...f.payload('Stop'), last_assistant_message: '中断后的回应' });
  assert.equal(fs.existsSync(join(f.root, 'transcripts')), false);
  for (const input of [
    { tool_name: 'Bash', tool_input: { command: 'Get-Content .therapy/persona.md' } },
    { tool_name: 'apply_patch', tool_input: { command: '*** Update File: profile.md\n@@\n-old\n+new' } },
    { tool_name: 'apply_patch', tool_input: { command: '*** Update File: .therapy/persona.md\n@@\n-old\n+new' } },
  ]) assert.equal(runtime.runHook(f.root, { ...f.payload('PreToolUse'), ...input }).hookSpecificOutput.permissionDecision, 'deny');
});

test('已知父线程的 Codex 分支沿用朋友设置，不重新选择或污染父会话', async t => {
  const f = await installed(t, true); runtime.runHook(f.root, f.payload('SessionStart'));
  modes.selectState(f.root, f.id, { mode: 'friend', persona: 'rational-companion', length: 'detailed' }, 'explicit');
  const source = join(f.sandbox, 'rollout-child-' + OTHER + '.jsonl'), childRows = records(f.root, OTHER);
  childRows[0].payload.forked_from_id = NATIVE;
  fs.writeFileSync(source, childRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const out = runtime.runHook(f.root, { ...f.payload('SessionStart'), session_id: OTHER, transcript_path: source, source: 'fork' });
  const selected = modes.readState(f.root, codex.conversationId(OTHER));
  assert.equal(selected.mode, 'friend'); assert.equal(selected.persona, 'rational-companion');
  assert.equal(selected.length, 'detailed'); assert.ok(out.hookSpecificOutput.additionalContext.includes('INNER_DIALOGUE_LOCK'));
});

test('安装后真正的脚本子进程可以从外部目录执行 Codex 生命周期与原文归档', async t => {
  const f = await installed(t), script = join(f.root, '.therapy/hooks/codex-runtime.cjs');
  const hook = payload => spawnSync(process.execPath, [script], { cwd: f.sandbox, input: JSON.stringify(payload), encoding: 'utf8' });
  assert.ok(JSON.parse(hook(f.payload('SessionStart')).stdout).hookSpecificOutput.additionalContext.includes('ARCHIVE_SESSION'));
  hook(f.payload('UserPromptSubmit'));
  const req = spawnSync(process.execPath, [join(f.root, '.therapy/hooks/transcript-archive.cjs'), '--request', '--session', f.id], { cwd: f.sandbox, encoding: 'utf8' });
  assert.equal(req.status, 0); assert.equal(JSON.parse(req.stdout).pending, true);
  assert.equal(hook({ ...f.payload('Stop'), last_assistant_message: '完整最终正文' }).status, 0);
  assert.ok(fs.existsSync(join(f.root, 'transcripts/index.json')));
  const log = fs.readFileSync(join(f.root, '.therapy/logs/runtime.jsonl'), 'utf8');
  assert.ok(log.includes('"client":"codex"')); assert.ok(!log.includes('完整最终正文'));
});

test('入口与设置增量合并并备份，预览只读，冻结咨询正文和旧资料保持字节', async t => {
  const f = await installed(t, true), entry = join(f.root, 'AGENTS.md'), config = join(f.root, '.codex/hooks.json');
  const baseline = fs.readFileSync(join(f.root, '.therapy/modes/counseling.md'));
  const original = fs.readFileSync(entry, 'utf8'); fs.writeFileSync(entry, '用户既有约定\r\n' + original);
  const settings = storage.read(config); settings.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'echo custom' }] }); storage.json(config, settings);
  const before = fs.readFileSync(config);
  const preview = await update({ path: f.root, dryRun: true });
  assert.deepEqual(fs.readFileSync(config), before); assert.ok(preview.dry_run);
  await update({ path: f.root });
  assert.ok(fs.readFileSync(entry, 'utf8').startsWith('用户既有约定\r\n'));
  assert.equal(storage.read(config).hooks.Stop[0].hooks[0].command, 'echo custom');
  assert.deepEqual(fs.readFileSync(join(f.root, '.therapy/modes/counseling.md')), baseline);
  assert.deepEqual((await archivePlan(f.root)).writes, []);
  assert.deepEqual(CODEX_EVENTS.filter(event => !storage.read(config).hooks[event]), []);
});

test('损坏 Codex 设置和本地自定义入口区块原样保留，不覆盖用户内容', async t => {
  const f = await installed(t), config = join(f.root, '.codex/hooks.json');
  fs.writeFileSync(config, '{BROKEN');
  const result = await applyArchiving(f.root);
  assert.ok(result.codex_error); assert.equal(fs.readFileSync(config, 'utf8'), '{BROKEN');
  const file = join(f.root, 'AGENTS.md'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('本地对话目录', '用户自定义的入口'));
  const custom = fs.readFileSync(file);
  const changed = await applyArchiving(f.root);
  assert.ok(changed.skipped.includes('AGENTS.md')); assert.deepEqual(fs.readFileSync(file), custom);
  assert.throws(() => mergeCodexHooks('{"hooks":{"Stop":{}}}', f.root), /数组/);
});
