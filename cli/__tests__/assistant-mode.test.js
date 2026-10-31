/**
 * 助手模式的业务回归：只使用临时安装与合成发言，绝不把测试记忆写入真实 Sage。
 * 验证两个客户端的实际脚本、分支隔离、共享保存、主动收尾和旧安装升级。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from '../install.js';
import { update } from '../update.js';
import { auditInteraction, digest, mergeModeHooks } from '../lib/interaction.js';
import { archivePlan } from '../lib/transcript-archiving.js';
import modes from '../../hooks/session-mode.cjs';
import memory from '../../hooks/shared-memory.cjs';
import archive from '../../hooks/transcript-archive.cjs';
import codex from '../../hooks/codex-transcript.cjs';
import usage from '../../hooks/usage-stats-context.cjs';
import storage from '../../hooks/local-storage.cjs';

const ID = '30000000-0000-0000-0000-000000000001';
const OTHER = '30000000-0000-0000-0000-000000000002';
const NATIVE = '30000000-0000-0000-0000-000000000003';

/** 清理前校验系统临时目录与专用前缀，测试数据不落在源码或私人资料目录。 */
async function fixture(t) {
  const sandbox = fs.mkdtempSync(join(tmpdir(), 'inner-dialogue-assistant-'));
  t.after(() => {
    assert.ok(resolve(sandbox).startsWith(resolve(tmpdir()) + sep));
    assert.ok(sandbox.includes('inner-dialogue-assistant-'));
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const root = join(sandbox, 'Sage');
  await install({ path: root, name: 'Sage', persona: 'coach', structure: 'moderate', modalities: ['cbt'], dualMode: true });
  return { root, sandbox };
}

/** 使用安装后的真实脚本，并从目录外执行；捕获输出只用于断言，不发送模型请求。 */
function run(f, script, args = [], payload) {
  const out = spawnSync(process.execPath, [join(f.root, '.therapy/hooks', script), ...args], { cwd: f.sandbox, encoding: 'utf8', windowsHide: true, ...(payload ? { input: JSON.stringify(payload) } : {}) });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  return out.stdout.trim() ? JSON.parse(out.stdout) : {};
}

/** 只对测试临时目录里的普通文件取哈希，检查预览与升级的私人资料保护。 */
function tree(root, prefix = '') {
  return Object.fromEntries(fs.readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    return entry.isDirectory() ? Object.entries(tree(root, rel)) : [[rel, digest(fs.readFileSync(join(root, rel)))]];
  }));
}

test('助手无需人格或篇幅，选择可重试，恢复与历史分支保持原模式', async t => {
  const f = await fixture(t);
  for (const choice of [{ mode: 'assistant', persona: 'coach' }, { mode: 'assistant', length: 'deep' }]) assert.throws(() => modes.validateChoice(choice), /助手模式不能/);
  const state = modes.selectState(f.root, ID, { mode: 'assistant' });
  assert.deepEqual(modes.selectState(f.root, ID, { mode: 'assistant' }), state);
  assert.throws(() => modes.selectState(f.root, ID, { mode: 'counseling' }), /永久锁定/);
  for (const source of ['resume', 'compact', 'clear']) {
    const text = modes.runHook({ session_id: ID, hook_event_name: 'SessionStart', source }, f.root).hookSpecificOutput.additionalContext;
    assert.match(text, /modes\/assistant\.md/);
    assert.doesNotMatch(text, /friend-personas|friend-lengths|modes\/counseling/);
    const paths = JSON.parse(text.split('\n').find(line => line.startsWith('INNER_DIALOGUE_PATHS ')).slice('INNER_DIALOGUE_PATHS '.length));
    assert.equal(paths.profile, join(f.root, 'profile.md'));
    assert.equal(paths.assistant_sessions, join(f.root, 'assistant-sessions'));
    assert.equal(paths.transcript_index, join(f.root, 'transcripts/index.json'));
  }
  const source = join(f.sandbox, 'branch.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [modes.contextFor(ID, state, f.root)] } }) + '\n');
  assert.equal(modes.resolveState(f.root, { session_id: OTHER, transcript_path: source }).mode, 'assistant');
});

test('助手允许背景与原文读取，拒绝其他分支配置、错误资料路径和直接改写规则', async t => {
  const f = await fixture(t), state = modes.selectState(f.root, ID, { mode: 'assistant' });
  const blocked = ['.therapy/persona.md', '.therapy/modalities/cbt.md', '.therapy/session-structure.md', '.therapy/modes/counseling.md', '.therapy/modes/friend.md', '.therapy/friend-personas/warm-talkative.md', '.therapy/friend-lengths/deep.md', '.therapy/friend-memory.md', '.therapy/commands.md', '.therapy/profile-protocol.md', '.therapy/usage-reflection.md'];
  for (const file of blocked) {
    for (const input of [{ tool_name: 'Read', tool_input: { file_path: join(f.root, file) } }, { tool_name: 'Bash', tool_input: { command: 'Get-Content "' + join(f.root, file) + '"' } }]) assert.ok(modes.deniedTool(f.root, input, state), file);
  }
  for (const file of ['profile.md', 'context/index.md', 'sessions/old.md', 'friend-sessions/old.md', 'assistant-sessions/old.md', 'transcripts/index.json', '.therapy/modes/assistant.md', '.therapy/assistant-memory.md', '.therapy/shared-memory-protocol.md', '.therapy/transcript-protocol.md', '.therapy/safety-protocol.md']) assert.equal(modes.deniedTool(f.root, { tool_name: 'Read', tool_input: { file_path: join(f.root, file) } }, state), null, file);
  assert.ok(modes.deniedTool(f.root, { tool_name: 'Read', tool_input: { file_path: '.therapy/assistant-sessions/old.md' } }, state));
  assert.ok(modes.deniedTool(f.root, { tool_name: 'Edit', tool_input: { file_path: '.therapy/assistant-memory.md' } }, state));
  for (const mode of ['friend', 'counseling']) assert.ok(modes.deniedTool(f.root, { tool_name: 'Read', tool_input: { file_path: '.therapy/modes/assistant.md' } }, { mode }));
});

test('Claude 助手共享保存后主动收尾，归档包含最终回应且元数据不带朋友设置', async t => {
  const f = await fixture(t), source = join(f.sandbox, ID + '.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: '今天先到这里。' } }) + '\n');
  const payload = event => ({ session_id: ID, transcript_path: source, hook_event_name: event });
  run(f, 'session-mode.cjs', ['--select', '--session', ID, '--mode', 'assistant']);
  run(f, 'shared-memory.cjs', [], payload('UserPromptSubmit'));
  run(f, 'transcript-archive.cjs', [], payload('UserPromptSubmit'));
  run(f, 'transcript-archive.cjs', [], { ...payload('Stop'), last_assistant_message: '普通回复不归档' });
  assert.equal(fs.existsSync(join(f.root, 'transcripts')), false);
  const base = run(f, 'shared-memory.cjs', ['--begin', '--session', ID]);
  assert.ok(base.summary.startsWith('assistant-sessions/'));
  storage.json(base.draft, { schema: 1, base_token: base.base_token, changes: [{ path: base.summary, content: '# 助手交流\n合成摘要\n' }] });
  run(f, 'shared-memory.cjs', ['--commit', '--session', ID, '--draft', base.draft]);
  run(f, 'transcript-archive.cjs', ['--request', '--session', ID]);
  run(f, 'transcript-archive.cjs', [], { ...payload('Stop'), last_assistant_message: '最后完整回应。' });
  const entry = storage.read(join(f.root, 'transcripts/index.json')).sessions[ID];
  const rows = fs.readFileSync(join(f.root, entry.jsonl), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entry.mode, 'assistant');
  assert.deepEqual(rows[0].settings, { mode: 'assistant' });
  assert.equal(rows.at(-1).text, '最后完整回应。');
  const logs = fs.readFileSync(join(f.root, '.therapy/logs/runtime.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(logs.some(row => row.event === 'mode.selected' && row.mode === 'assistant'));
  assert.ok(!JSON.stringify(logs).includes('合成摘要'));
});

test('Codex 助手的真实脚本完成模式隔离、共享提交、原文归档和父分支继承', async t => {
  const f = await fixture(t), id = codex.conversationId(NATIVE), source = join(f.sandbox, 'rollout-' + NATIVE + '.jsonl');
  const rows = [{ type: 'session_meta', payload: { id: NATIVE, cwd: f.root } }, { type: 'event_msg', payload: { type: 'user_message', message: '今天先到这里。' } }];
  fs.writeFileSync(source, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const payload = event => ({ session_id: NATIVE, transcript_path: source, cwd: f.root, hook_event_name: event, prompt: '今天先到这里。' });
  run(f, 'codex-runtime.cjs', [], payload('SessionStart'));
  run(f, 'session-mode.cjs', ['--select', '--session', id, '--mode', 'assistant']);
  const out = run(f, 'codex-runtime.cjs', [], payload('UserPromptSubmit')).hookSpecificOutput.additionalContext;
  assert.match(out, /modes\/assistant\.md/);
  assert.doesNotMatch(out, /咨询师对话|friend-lengths|friend-personas|usage-reflection/);
  for (const tool_name of ['exec_command', 'functions.exec_command', 'shell_command', 'shell']) {
    const guarded = run(f, 'codex-runtime.cjs', [], { ...payload('PreToolUse'), tool_name, tool_input: { cmd: 'Get-Content .therapy/persona.md' } });
    assert.equal(guarded.hookSpecificOutput.permissionDecision, 'deny');
  }
  const base = run(f, 'shared-memory.cjs', ['--begin', '--session', id]);
  storage.json(base.draft, { schema: 1, base_token: base.base_token, changes: [{ path: base.summary, content: '# 助手交流\nCodex 合成摘要\n' }] });
  run(f, 'shared-memory.cjs', ['--commit', '--session', id, '--draft', base.draft]);
  run(f, 'transcript-archive.cjs', ['--request', '--session', id]);
  run(f, 'codex-runtime.cjs', [], { ...payload('Stop'), last_assistant_message: 'Codex 最后一轮完整回应。' });
  const entry = storage.read(join(f.root, 'transcripts/index.json')).sessions[id];
  assert.equal(entry.mode, 'assistant');
  assert.match(fs.readFileSync(join(f.root, entry.markdown), 'utf8'), /Codex 最后一轮完整回应。/);
  const child = join(f.sandbox, 'rollout-child-' + OTHER + '.jsonl');
  fs.writeFileSync(child, JSON.stringify({ type: 'session_meta', payload: { id: OTHER, cwd: f.root, forked_from_id: NATIVE } }) + '\n');
  run(f, 'codex-runtime.cjs', [], { ...payload('SessionStart'), session_id: OTHER, transcript_path: child, source: 'fork' });
  assert.equal(modes.readState(f.root, codex.conversationId(OTHER)).mode, 'assistant');
});

test('助手摘要受共享写锁和基线保护，不能写入其他模式或其他会话摘要', async t => {
  const f = await fixture(t);
  modes.selectState(f.root, ID, { mode: 'assistant' });
  modes.selectState(f.root, OTHER, { mode: 'friend', persona: 'warm-talkative', length: 'standard' });
  for (const session_id of [ID, OTHER]) memory.runHook(f.root, { session_id, hook_event_name: 'UserPromptSubmit' });
  const a = memory.begin(f.root, ID), b = memory.begin(f.root, OTHER);
  storage.json(a.draft, { schema: 1, base_token: a.base_token, changes: [{ path: a.summary, content: '助手已发布' }] });
  memory.commit(f.root, ID, a.draft);
  storage.json(b.draft, { schema: 1, base_token: b.base_token, changes: [{ path: b.summary, content: '朋友旧基线' }] });
  assert.throws(() => memory.commit(f.root, OTHER, b.draft), /基线失效/);
  for (const path of ['sessions/' + a.date + '-' + ID + '.md', 'friend-sessions/' + a.date + '-' + ID + '.md', 'assistant-sessions/' + a.date + '-' + OTHER + '.md']) assert.equal(memory.allowed(path, ID, 'assistant'), false);
  for (const tool of [{ tool_name: 'Write', tool_input: { file_path: join(f.root, a.summary) } }, { tool_name: 'Bash', tool_input: { command: 'Set-Content assistant-sessions/new.md text' } }]) assert.ok(memory.denied(f.root, tool, ID));
  storage.json(join(f.root, '.therapy/memory-write.lock'), { pid: process.pid, token: OTHER });
  assert.ok(memory.denied(f.root, { tool_name: 'Bash', tool_input: { command: 'Get-ChildItem assistant-sessions' } }, ID));
});

test('使用统计仍记录但助手及待选模式不接收节奏建议，咨询朋友保留原输出', async t => {
  const f = await fixture(t), text = '合成统计事实，见 .therapy/usage-reflection.md';
  assert.equal(usage.filter(f.root, { session_id: ID }, text), '');
  modes.selectState(f.root, ID, { mode: 'assistant' });
  assert.equal(usage.filter(f.root, { session_id: ID }, text), '');
  modes.selectState(f.root, OTHER, { mode: 'counseling' });
  assert.equal(usage.filter(f.root, { session_id: OTHER }, text), text);
  modes.selectState(f.root, NATIVE, { mode: 'friend', persona: 'warm-talkative', length: 'standard' });
  assert.equal(usage.filter(f.root, { session_id: NATIVE }, text), text);
  run(f, 'usage-stats-context.cjs', [join(f.root, '.therapy/hooks/usage-stats.js')], { session_id: ID, hook_event_name: 'SessionStart', source: 'startup', cwd: f.root });
  assert.ok(fs.readFileSync(join(f.root, '.therapy/usage-log.txt'), 'utf8').includes(ID));
  const raw = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.therapy/hooks/usage-stats.js'] }, { command: 'custom usage-stats.js --special' }] }] } });
  const merged = mergeModeHooks(raw);
  assert.equal(merged.hooks.SessionStart[0].hooks[1].command, 'custom usage-stats.js --special');
  assert.deepEqual(mergeModeHooks(JSON.stringify(merged)), merged);
});

test('旧双模式安装可只读预览后升级助手入口，保留咨询原字节、私人资料和已有锁定', async t => {
  const f = await fixture(t), cfgPath = join(f.root, '.therapy/interaction.json'), cfg = storage.read(cfgPath);
  const registryPath = join(f.root, '.therapy/archive-version.json'), registry = storage.read(registryPath);
  for (const rel of ['.therapy/modes/assistant.md', '.therapy/assistant-memory.md', '.therapy/hooks/usage-stats-context.cjs']) {
    fs.unlinkSync(join(f.root, rel)); delete cfg.files[rel]; delete registry.files[rel];
  }
  for (const rel of ['CLAUDE.md', '.therapy/hooks/session-mode.cjs']) {
    const legacy = '合成旧双模式资产：升级前保留的测试版本\n';
    fs.writeFileSync(join(f.root, rel), legacy); cfg.files[rel] = digest(legacy);
    if (registry.files[rel]) registry.files[rel] = digest(legacy);
  }
  cfg.extension_version = '1.0.0'; storage.json(cfgPath, cfg); storage.json(registryPath, registry);
  const settingsPath = join(f.root, '.claude/settings.json'), settings = storage.read(settingsPath);
  for (const group of settings.hooks.SessionStart) for (const hook of group.hooks) if (hook.args?.[0]?.endsWith('/usage-stats-context.cjs')) hook.args = [hook.args[1]];
  storage.json(settingsPath, settings);
  modes.selectState(f.root, ID, { mode: 'counseling' });
  fs.writeFileSync(join(f.root, 'sessions/old.md'), '合成私人旧记录');
  const before = tree(f.root), preview = await update({ path: f.root, dryRun: true });
  assert.deepEqual(tree(f.root), before);
  assert.ok(preview.plan.writes.includes('.therapy/modes/assistant.md'));
  const result = await update({ path: f.root });
  assert.deepEqual(result.plan.skipped_user_edited, []);
  assert.equal(storage.read(cfgPath).extension_version, '1.1.0');
  for (const rel of ['profile.md', 'context/index.md', 'sessions/old.md', '.therapy/conversations/' + ID + '.json', ...Object.keys(cfg.protected_files)]) assert.equal(digest(fs.readFileSync(join(f.root, rel))), before[rel], rel);
  assert.deepEqual((await auditInteraction(f.root)).errors, []);
  assert.deepEqual((await archivePlan(f.root)).writes, []);
});
