/**
 * 摘要目录导航回归：缺失目录正常跳过，所有查询只读，跨目录搜索不包含尚未创建的路径。
 * 使用临时目录重放首次对话场景，不创建真实 Sage 的测试摘要或记忆。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { install } from '../install.js';
import memory from '../../hooks/shared-memory.cjs';
const ID = '50000000-0000-0000-0000-000000000001';

/** 清理目标必须是测试创建的系统临时子目录，不接受用户资料路径。 */
function fixture(t) {
  const sandbox = fs.mkdtempSync(join(tmpdir(), 'inner-dialogue-sources-'));
  t.after(() => { assert.ok(resolve(sandbox).startsWith(resolve(tmpdir()) + sep)); assert.ok(sandbox.includes('inner-dialogue-sources-')); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return sandbox;
}

/** 比较全部现有文件字节，确保目录导航命令不写状态、日志、配置或摘要。 */
function tree(root, rel = '') {
  return Object.fromEntries(fs.readdirSync(join(root, rel), { withFileTypes: true }).flatMap(e => {
    const name = rel ? rel + '/' + e.name : e.name;
    return e.isDirectory() ? Object.entries(tree(root, name)) : [[name, fs.readFileSync(join(root, name)).toString('base64')]];
  }));
}

test('三种摘要目录的八种存在组合均只返回实际目录，不为读取创建目录', t => {
  const root = fixture(t), names = ['sessions', 'friend-sessions', 'assistant-sessions'];
  for (let mask = 0; mask < 8; mask++) {
    const caseRoot = join(root, String(mask)); fs.mkdirSync(caseRoot);
    const expected = names.filter((_, n) => mask & (1 << n)).map(name => join(caseRoot, name));
    expected.forEach(dir => fs.mkdirSync(dir));
    const before = fs.readdirSync(caseRoot);
    assert.deepEqual(memory.sources(caseRoot).summary_directories, expected);
    assert.deepEqual(fs.readdirSync(caseRoot), before);
  }
});

test('同一资料版本下的目录变化会刷新导航，普通文件不伪装为空目录', t => {
  const root = fixture(t); fs.mkdirSync(join(root, '.therapy'));
  const context = () => JSON.parse(memory.runHook(root, { session_id: ID, hook_event_name: 'UserPromptSubmit' }).hookSpecificOutput.additionalContext.split('\n')[0].slice('INNER_DIALOGUE_MEMORY '.length));
  const before = context(); assert.deepEqual(before.summary_directories, []);
  fs.mkdirSync(join(root, 'assistant-sessions'));
  const after = context(); assert.deepEqual(after.summary_directories, [join(root, 'assistant-sessions')]);
  assert.equal(before.revision, after.revision);
  fs.writeFileSync(join(root, 'friend-sessions'), '占位文件');
  assert.throws(() => memory.sources(root), /不是普通目录/);
});

test('已安装来源查询从目录外执行仍只读，首次搜索不访问缺失的朋友及助手目录', async t => {
  const sandbox = fixture(t), root = join(sandbox, 'Sage');
  await install({ path: root, name: 'Sage', persona: 'coach', structure: 'moderate', modalities: ['cbt'], dualMode: true });
  fs.writeFileSync(join(root, 'sessions/old.md'), '邦创 RoboCup 合成背景');
  const before = tree(root);
  const query = spawnSync(process.execPath, [join(root, '.therapy/hooks/shared-memory.cjs'), '--sources', '--session', ID], { cwd: sandbox, encoding: 'utf8', windowsHide: true });
  assert.equal(query.status, 0, query.stdout + query.stderr);
  const dirs = JSON.parse(query.stdout).summary_directories;
  assert.deepEqual(dirs, [join(root, 'sessions')]);
  assert.deepEqual(tree(root), before);
  assert.equal(fs.existsSync(join(root, 'friend-sessions')), false);
  assert.equal(fs.existsSync(join(root, 'assistant-sessions')), false);
  const available = spawnSync('rg', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (available.error?.code === 'ENOENT') return;
  const search = spawnSync('rg', ['-n', '--glob', '*.md', '邦创|RoboCup', ...dirs], { cwd: sandbox, encoding: 'utf8', windowsHide: true });
  assert.equal(search.status, 0, search.stderr); assert.equal(search.stderr, ''); assert.match(search.stdout, /合成背景/);
});
