/** 统一日志回归只使用合成资料；验证隐私、失败回执、并发追加、轮转及安装升级。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import runtime from '../../hooks/runtime-log.cjs';
import { install } from '../install.js';
import { update } from '../update.js';
import { auditInteraction, readInteraction } from '../lib/interaction.js';
import { mergeRuntimeHooks } from '../lib/runtime-logging.js';

const SCRIPT = fileURLToPath(new URL('../../hooks/runtime-log.cjs', import.meta.url));
const CLI = fileURLToPath(new URL('../../bin/inner-dialogue.js', import.meta.url));
const ID = '10000000-0000-0000-0000-000000000001';

/** 清理仅针对本测试确切创建的临时目录，不读取或删除真实治疗师资料。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'inner-dialogue-runtime-log-'));
  mkdirSync(join(root, '.therapy'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(root.includes('inner-dialogue-runtime-log-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** 每一行独立解析，截断或交错写入不能伪装成有效日志。 */
function records(root) {
  return readFileSync(join(root, '.therapy/logs/runtime.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('工具失败保留会话与相对文件路径，但不保存正文、命令、密钥或原始错误', t => {
  const root = fixture(t);
  runtime.observe({ hook_event_name: 'PostToolUseFailure', session_id: ID, tool_name: 'Read', tool_use_id: 'toolu_test', tool_input: { file_path: join(root, 'profile.md'), content: 'PRIVATE_PROFILE', command: 'SECRET_COMMAND' }, error: 'File does not exist. SECRET_TOKEN', prompt: 'PRIVATE_CHAT', tool_response: 'PRIVATE_RESPONSE' }, root);
  const raw = readFileSync(join(root, '.therapy/logs/runtime.jsonl'), 'utf8');
  for (const secret of ['PRIVATE_PROFILE', 'SECRET_COMMAND', 'SECRET_TOKEN', 'PRIVATE_CHAT', 'PRIVATE_RESPONSE']) assert.ok(!raw.includes(secret));
  const [row] = records(root);
  assert.equal(row.session_id, ID);
  assert.equal(row.file, 'profile.md');
  assert.equal(row.event, 'tool.failure');
  assert.equal(row.error.code, 'ENOENT');
});

test('日志无法写入不抛异常、不改变被观察操作，也不会建立新的咨询目录', t => {
  const root = fixture(t);
  writeFileSync(join(root, '.therapy/logs'), '合成阻塞文件');
  assert.equal(runtime.writeEvent(root, { event: 'test.failure' }).ok, false);
  const missing = join(root, 'not-installed');
  assert.equal(runtime.writeEvent(missing, { event: 'test.failure' }).ok, false);
  assert.equal(existsSync(missing), false);
});

test('达到大小上限后有界轮转，所有保留记录仍可按行解析', t => {
  const root = fixture(t);
  for (let n = 0; n < 60; n++) assert.equal(runtime.writeEvent(root, { event: 'rotation.test', exit_code: n }, { maxBytes: 600 }).ok, true);
  const files = readdirSync(join(root, '.therapy/logs')).sort();
  assert.deepEqual(files, ['runtime.jsonl', 'runtime.jsonl.1', 'runtime.jsonl.2', 'runtime.jsonl.3']);
  for (const file of files) for (const line of readFileSync(join(root, '.therapy/logs', file), 'utf8').trim().split('\n')) JSON.parse(line);
  assert.equal(records(root).at(-1).exit_code, 59);
});

test('并行钩子追加不会覆盖其他事件或写出交错 JSON', async t => {
  const root = fixture(t);
  const children = Array.from({ length: 8 }, () => new Promise((done, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: root });
    child.stdin.end(JSON.stringify({ cwd: root, session_id: ID, hook_event_name: 'SessionStart' }));
    child.on('error', reject);
    child.on('close', code => code === 0 ? done() : reject(new Error('观察钩子退出失败')));
  }));
  await Promise.all(children);
  assert.equal(records(root).length, 8);
});

test('真实钩子进程成功和输入错误均不向 stdout 注入上下文，错误仍写日志', t => {
  const root = fixture(t);
  for (const input of [JSON.stringify({ cwd: root, session_id: ID, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(root, 'sessions/test.md'), content: 'PRIVATE_WRITE' } }), '{bad-json']) {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, input, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  const rows = records(root);
  assert.equal(rows[0].event, 'tool.success');
  assert.equal(rows[1].error.code, 'INVALID_JSON');
});

test('设置合并保留原配置及钩子顺序，重复注册完全幂等', () => {
  const old = { extra: 'keep', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-existing' }] }] } };
  const settings = mergeRuntimeHooks(JSON.stringify(old));
  assert.equal(settings.extra, 'keep');
  assert.deepEqual(settings.hooks.UserPromptSubmit[0], old.hooks.UserPromptSubmit[0]);
  for (const event of runtime.EVENTS) assert.equal(settings.hooks[event].filter(g => JSON.stringify(g).includes('runtime-log.cjs')).length, 1);
  assert.deepEqual(mergeRuntimeHooks(JSON.stringify(settings)), settings);
  assert.throws(() => mergeRuntimeHooks('{"hooks":{"PostToolUseFailure":{}}}'));
});

test('已有双模式安装补入日志模块和事件，咨询基线及个人档案保持不变', async t => {
  const parent = fixture(t), root = join(parent, 'Sage');
  await install({ path: root, name: 'Sage', persona: 'direct-challenging', structure: 'moderate', modalities: ['cbt'], json: true, dualMode: true });
  const before = readFileSync(join(root, '.therapy/modes/counseling.md'));
  const profile = readFileSync(join(root, 'profile.md'));
  const cfg = await readInteraction(root);
  delete cfg.files['.therapy/hooks/runtime-log.cjs'];
  writeFileSync(join(root, '.therapy/interaction.json'), JSON.stringify(cfg));
  rmSync(join(root, '.therapy/hooks/runtime-log.cjs'));
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  for (const event of runtime.EVENTS) settings.hooks[event] = (settings.hooks[event] || []).filter(g => !JSON.stringify(g).includes('runtime-log.cjs'));
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(settings));
  const preview = await update({ path: root, dryRun: true });
  assert.ok(preview.plan.writes.includes('.therapy/hooks/runtime-log.cjs'));
  assert.equal(existsSync(join(root, '.therapy/hooks/runtime-log.cjs')), false);
  await update({ path: root });
  assert.deepEqual(readFileSync(join(root, '.therapy/modes/counseling.md')), before);
  assert.deepEqual(readFileSync(join(root, 'profile.md')), profile);
  assert.deepEqual((await auditInteraction(root)).errors, []);
  const repaired = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(mergeRuntimeHooks(JSON.stringify(repaired)), repaired);
});

test('CLI 安装完成与失败记录到目标目录，dry-run 连日志也不写', async t => {
  const parent = fixture(t), root = join(parent, 'Sage');
  const args = ['install', '--name', 'Sage', '--path', root, '--persona', 'coach', '--structure', 'moderate', '--modalities', 'cbt', '--json'];
  assert.equal(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }).status, 0);
  assert.equal(records(root).at(-1).event, 'command.complete');
  assert.equal(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }).status, 1);
  assert.equal(records(root).at(-1).event, 'command.failure');
  const before = readFileSync(join(root, '.therapy/logs/runtime.jsonl'));
  assert.equal(spawnSync(process.execPath, [CLI, 'update', '--path', root, '--dry-run', '--json'], { encoding: 'utf8' }).status, 0);
  assert.deepEqual(readFileSync(join(root, '.therapy/logs/runtime.jsonl')), before);
});
