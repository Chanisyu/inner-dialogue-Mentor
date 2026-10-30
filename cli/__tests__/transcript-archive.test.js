/** 主动收尾归档只使用合成对话，覆盖最终回应、隐私、分支、重复和失败保护。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import archive from '../../hooks/transcript-archive.cjs';
import { install } from '../install.js';
import { update } from '../update.js';
import { archivePlan, applyArchiving, mergeArchiveHooks } from '../lib/transcript-archiving.js';

const ID = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';

/** 临时根下创建独立咨询与来源文件，清理前检查根目录，绝不接触私人会话。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'inner-dialogue-archive-'));
  mkdirSync(join(root, '.therapy'));
  const source = join(root, ID + '.jsonl');
  const rows = [{ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-10-30T10:00:00Z', message: { content: '今天先到这里。\n保留这一句原文。' } }];
  const flush = () => writeFileSync(source, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  flush();
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); assert.ok(root.includes('inner-dialogue-archive-')); rmSync(root, { recursive: true, force: true }); });
  const payload = event => ({ session_id: ID, transcript_path: source, hook_event_name: event });
  archive.runHook(root, payload('UserPromptSubmit'));
  return { root, source, rows, flush, payload };
}

/** 通过已发布索引回查底稿，验证两种视图来自同一完整快照。 */
function saved(root, id = ID) {
  const index = JSON.parse(readFileSync(join(root, 'transcripts/index.json'), 'utf8'));
  const entry = index.sessions[id];
  return { entry, rows: readFileSync(join(root, entry.jsonl), 'utf8').trim().split('\n').map(JSON.parse), md: readFileSync(join(root, entry.markdown), 'utf8') };
}

test('普通 Stop 和退出事件均不归档，请求本身也不保存正文', t => {
  const f = fixture(t);
  archive.runHook(f.root, { ...f.payload('Stop'), last_assistant_message: '正常回复' });
  archive.runHook(f.root, f.payload('SessionEnd'));
  assert.equal(existsSync(join(f.root, 'transcripts')), false);
  archive.request(f.root, ID);
  assert.equal(existsSync(join(f.root, 'transcripts')), false);
  assert.ok(!readFileSync(join(f.root, '.therapy/archive-state', ID + '.json'), 'utf8').includes('保留这一句原文'));
});

test('主动请求后在 Stop 归档，原始来源尚无最后回应时也保存完整收尾文字', t => {
  const f = fixture(t);
  archive.request(f.root, ID);
  archive.runHook(f.root, { ...f.payload('Stop'), last_assistant_message: '好的，今天先到这里。\n下次再聊。' });
  const result = saved(f.root);
  assert.equal(result.rows[0].mode, 'counseling');
  assert.deepEqual(result.rows.slice(1).map(m => m.text), ['今天先到这里。\n保留这一句原文。', '好的，今天先到这里。\n下次再聊。']);
  assert.ok(result.md.includes('M0002'));
  assert.ok(result.md.includes('下次再聊。'));
  const folders = readdirSync(join(f.root, 'transcripts', ID));
  archive.runHook(f.root, { ...f.payload('Stop'), last_assistant_message: '重复回调' });
  assert.deepEqual(readdirSync(join(f.root, 'transcripts', ID)), folders);
});

test('最终消息已写入时不重复追加；内部推理、工具结果和平台注入不进入底稿', t => {
  const f = fixture(t);
  f.rows.push({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'am1', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'tool_use', id: 'tool1', input: { secret: 'PRIVATE_TOOL' } }] } });
  f.rows.push({ type: 'user', uuid: 't1', parentUuid: 'a1', message: { content: [{ type: 'tool_result', content: 'PRIVATE_RESULT' }] } });
  f.rows.push({ type: 'attachment', uuid: 'inject', parentUuid: 't1', attachment: { content: 'PRIVATE_INSTRUCTIONS' } });
  f.flush(); archive.request(f.root, ID);
  f.rows.push({ type: 'assistant', uuid: 'a2', parentUuid: 'inject', message: { id: 'am2', content: [{ type: 'text', text: '完整结束回应' }] } });
  f.flush(); archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '完整结束回应' });
  const result = saved(f.root);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows.at(-1).id, 'am2');
  for (const secret of ['PRIVATE_THINKING', 'PRIVATE_TOOL', 'PRIVATE_RESULT', 'PRIVATE_INSTRUCTIONS']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('新消息撤销未完成收尾，不能在下一轮普通回复时误归档', t => {
  const f = fixture(t); archive.request(f.root, ID);
  archive.runHook(f.root, f.payload('UserPromptSubmit'));
  archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '继续聊' });
  assert.equal(existsSync(join(f.root, 'transcripts')), false);
});

test('中断恢复或压缩后的启动事件撤销旧请求，不在恢复回复时补归档', t => {
  const f = fixture(t); archive.request(f.root, ID);
  archive.runHook(f.root, { ...f.payload('SessionStart'), source: 'resume' });
  archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '恢复交流' });
  assert.equal(existsSync(join(f.root, 'transcripts')), false);
});

test('即使漏掉新消息钩子，Stop 仍核对用户轮次，阻止旧请求归档新内容', t => {
  const f = fixture(t); archive.request(f.root, ID);
  f.rows.push({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: '我还想继续' } }); f.flush();
  assert.equal(archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '继续' }).cancelled, true);
  assert.equal(existsSync(join(f.root, 'transcripts')), false);
});

test('附件只保存回查引用，base64 不落盘；分支只保留当前路径', () => {
  const rows = [
    { type: 'user', uuid: 'u', parentUuid: null, message: { content: [{ type: 'text', text: '看图片' }, { type: 'image', source: { data: 'PRIVATE_BASE64' } }] } },
    { type: 'assistant', uuid: 'old', parentUuid: 'u', message: { id: 'old', content: '旧分支' } },
    { type: 'assistant', uuid: 'new', parentUuid: 'u', message: { id: 'new', content: '新分支' } },
  ];
  const result = archive.extract(rows);
  assert.deepEqual(result.map(m => m.text), ['看图片', '新分支']);
  assert.equal(result[0].attachments[0].reference, 'client-message:u:block:1');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_BASE64'));
});

test('助手分片与完整快照可合并，反复读取不复制文字', () => {
  const rows = ['第一段', '第二段', '第一段第二段', '第一段'].map((text, n) => ({ type: 'assistant', uuid: 'a' + n, message: { id: 'same', content: [{ type: 'text', text }] } }));
  assert.equal(archive.extract(rows)[0].text, '第一段第二段');
});

test('带编号的不同内容块保留重复原话，同一块只更新完整快照', () => {
  const row = (index, text, n) => ({ type: 'assistant', uuid: 'block-' + n, apiBlockIndex: index, message: { id: 'same-message', content: [{ type: 'text', text }] } });
  const rows = [row(1, '我听到了。', 0), row(2, '我听到了。', 1), row(2, '我听到了。你可以慢慢说。', 2)];
  assert.equal(archive.extract(rows)[0].text, '我听到了。\n我听到了。你可以慢慢说。');
  assert.throws(() => archive.extract([...rows, row(2, '完全不同的快照', 3)]), /不一致快照/);
  const mixed = row(3, '无序号', 4); delete mixed.apiBlockIndex;
  assert.throws(() => archive.extract([...rows, mixed]), /标识不一致/);
});

test('最终回应已包含于新助手消息的最后内容块时不重复追加', t => {
  const f = fixture(t); archive.request(f.root, ID);
  f.rows.push({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', apiBlockIndex: 1, message: { id: 'final-message', content: [{ type: 'text', text: '已完成本轮整理。' }] } });
  f.rows.push({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', apiBlockIndex: 3, message: { id: 'final-message', content: [{ type: 'text', text: '今天先到这里。' }] } });
  f.flush(); archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '今天先到这里。' });
  const result = saved(f.root);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows.at(-1).text, '已完成本轮整理。\n今天先到这里。');
});

test('错误 ID、来源不匹配、损坏历史和缺少最终正文均明确拒绝', t => {
  const f = fixture(t);
  assert.throws(() => archive.request(f.root, '../escape'));
  assert.throws(() => archive.runHook(f.root, { ...f.payload('SessionStart'), transcript_path: join(f.root, OTHER + '.jsonl') }));
  writeFileSync(f.source, '{bad}\n'); assert.throws(() => archive.request(f.root, ID), /损坏/);
  f.flush(); archive.request(f.root, ID); assert.throws(() => archive.finish(f.root, f.payload('Stop')), /最终/);
  assert.equal(existsSync(join(f.root, 'transcripts')), false);
});

test('发布失败保留旧索引与旧底稿；其他会话不会被覆盖', t => {
  const f = fixture(t); archive.request(f.root, ID);
  archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '第一次结束' });
  const index = readFileSync(join(f.root, 'transcripts/index.json'));
  archive.request(f.root, ID);
  writeFileSync(join(f.root, 'transcripts/.publish.lock'), String(process.pid));
  assert.throws(() => archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '第二次结束' }), /发布正在/);
  assert.deepEqual(readFileSync(join(f.root, 'transcripts/index.json')), index);
  assert.equal(saved(f.root).rows.at(-1).text, '第一次结束');
});

test('朋友模式元数据来自锁定状态，正文规则与模型解释不作为共享事实导出', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.therapy/interaction.json'), JSON.stringify({ enabled: true }));
  mkdirSync(join(f.root, '.therapy/conversations'));
  writeFileSync(join(f.root, '.therapy/conversations', ID + '.json'), JSON.stringify({ locked: true, session_id: ID, mode: 'friend', persona: 'warm-talkative', length: 'detailed' }));
  archive.request(f.root, ID); archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '朋友收尾' });
  assert.equal(saved(f.root).rows[0].settings.persona, 'warm-talkative');
});

test('普通和双模式安装及升级接入三种事件，不注册 SessionEnd，预览不写入', async t => {
  const f = fixture(t), root = join(f.root, 'Sage');
  await install({ path: root, name: 'Sage', persona: 'coach', structure: 'moderate', modalities: ['cbt'], dualMode: true, json: true });
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(mergeArchiveHooks(JSON.stringify(settings)), settings);
  assert.ok(!JSON.stringify(settings.hooks.SessionEnd).includes('transcript-archive.cjs'));
  assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').includes('/transcripts/'));
  assert.equal(existsSync(join(root, 'transcripts')), false);
  const before = readFileSync(join(root, '.therapy/modes/counseling.md'));
  const plan = await archivePlan(root); assert.deepEqual(plan.writes, []);
  await update({ path: root, dryRun: true });
  assert.deepEqual(readFileSync(join(root, '.therapy/modes/counseling.md')), before);
});

/** 使用真正安装后的子进程入口，验证工作目录变化、标准输入与 Stop 最后正文的组合。 */
test('已安装脚本能从其他工作目录请求归档，失败写诊断但不泄露正文', async t => {
  const f = fixture(t), root = join(f.root, 'Installed');
  await install({ path: root, name: 'Installed', persona: 'coach', structure: 'moderate', modalities: ['cbt'] });
  const script = join(root, '.therapy/hooks/transcript-archive.cjs');
  const hook = payload => spawnSync(process.execPath, [script], { cwd: f.root, input: JSON.stringify(payload), encoding: 'utf8' });
  const start = hook(f.payload('SessionStart'));
  assert.equal(start.status, 0);
  assert.ok(start.stdout.includes('ARCHIVE_SESSION'));
  const requested = spawnSync(process.execPath, [script, '--request', '--session', ID], { cwd: f.root, encoding: 'utf8' });
  assert.equal(requested.status, 0); assert.equal(JSON.parse(requested.stdout).pending, true);
  assert.equal(existsSync(join(root, 'transcripts')), false);
  const stop = hook({ ...f.payload('Stop'), last_assistant_message: 'PRIVATE_FINAL_BODY' });
  assert.equal(stop.status, 0); assert.equal(stop.stdout, '');
  assert.equal(saved(root).rows.at(-1).text, 'PRIVATE_FINAL_BODY');
  const before = readFileSync(join(root, 'transcripts/index.json'));
  spawnSync(process.execPath, [script, '--request', '--session', ID], { cwd: f.root });
  const failure = hook(f.payload('Stop'));
  assert.equal(failure.status, 0); assert.ok(failure.stderr.includes('归档未完成'));
  assert.deepEqual(readFileSync(join(root, 'transcripts/index.json')), before);
  const log = readFileSync(join(root, '.therapy/logs/runtime.jsonl'), 'utf8');
  assert.ok(log.includes('archive.complete')); assert.ok(log.includes('archive.failure'));
  assert.ok(!log.includes('PRIVATE_FINAL_BODY')); assert.ok(!log.includes('保留这一句原文'));
});

test('各会话索引独立保留，同一会话再次收尾保留旧快照', t => {
  const f = fixture(t); archive.request(f.root, ID);
  archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '第一次结束' });
  const first = saved(f.root).entry;
  const otherSource = join(f.root, OTHER + '.jsonl');
  writeFileSync(otherSource, JSON.stringify({ type: 'user', uuid: 'other-user', message: { content: '另一次交流结束' } }) + '\n');
  archive.runHook(f.root, { hook_event_name: 'UserPromptSubmit', session_id: OTHER, transcript_path: otherSource });
  archive.request(f.root, OTHER); archive.finish(f.root, { session_id: OTHER, last_assistant_message: '另一次回应' });
  f.rows.push({ type: 'assistant', uuid: 'old-final', parentUuid: 'u1', message: { id: 'old-final-id', content: '第一次结束' } });
  f.rows.push({ type: 'user', uuid: 'new-close', parentUuid: 'old-final', message: { content: '补充一句，今天就到这里' } });
  f.flush(); archive.runHook(f.root, f.payload('UserPromptSubmit')); archive.request(f.root, ID);
  archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '第二次结束' });
  assert.equal(saved(f.root, OTHER).rows.at(-1).text, '另一次回应');
  assert.equal(saved(f.root).entry.message_count, 4);
  assert.ok(existsSync(join(f.root, first.jsonl)));
  assert.equal(readdirSync(join(f.root, 'transcripts', ID)).length, 2);
});

test('用户修改的归档脚本不覆盖或新增注册；损坏设置原样保留', async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, '.therapy/hooks')); mkdirSync(join(f.root, '.claude'));
  const custom = join(f.root, '.therapy/hooks/transcript-archive.cjs');
  writeFileSync(custom, '// 用户自定义归档组件\n', 'utf8');
  writeFileSync(join(f.root, '.claude/settings.json'), '{}');
  const result = await applyArchiving(f.root);
  assert.ok(result.skipped.includes('.therapy/hooks/transcript-archive.cjs'));
  assert.ok(result.settings_error); assert.equal(readFileSync(custom, 'utf8'), '// 用户自定义归档组件\n');
  assert.equal(readFileSync(join(f.root, '.claude/settings.json'), 'utf8'), '{}');
  writeFileSync(join(f.root, '.claude/settings.json'), '{BROKEN');
  await applyArchiving(f.root);
  assert.equal(readFileSync(join(f.root, '.claude/settings.json'), 'utf8'), '{BROKEN');
});

test('登记文件损坏时停止部署，不覆盖现有资产', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.therapy/archive-version.json'), JSON.stringify({ schema: 1, files: [] }));
  await assert.rejects(applyArchiving(f.root), /登记损坏/);
  assert.equal(existsSync(join(f.root, '.therapy/hooks')), false);
});

test('归档目标经过链接时拒绝，不将正文写到链接目标', t => {
  const f = fixture(t), target = join(f.root, 'other-directory'); mkdirSync(target);
  try { symlinkSync(target, join(f.root, 'transcripts'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) { t.skip('当前平台无法创建目录链接'); return; } throw err; }
  archive.request(f.root, ID);
  assert.throws(() => archive.finish(f.root, { ...f.payload('Stop'), last_assistant_message: '不应写入' }), /符号链接/);
  assert.deepEqual(readdirSync(target), []);
});
