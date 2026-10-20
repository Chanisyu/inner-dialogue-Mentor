// 双模式的安装与回滚集成测试：使用合成资料，逐字比对原咨询入口和个人数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { install } from '../install.js';
import { update } from '../update.js';
import { doctor } from '../doctor.js';
import { enableDualMode, disableDualMode, auditInteraction, digest, mergeModeHooks, readInteraction } from '../lib/interaction.js';

/** 每项测试均使用独立的已安装目录；清理前核对确切临时根，避免越界删除。 */
async function fixture(t, dualMode = false) {
  const root = await mkdtemp(join(tmpdir(), 'inner-dialogue-dual-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(root.includes('inner-dialogue-dual-'));
    await rm(root, { recursive: true, force: true });
  });
  await install({ path: root, name: 'Sage', persona: 'direct-challenging', structure: 'moderate', modalities: ['cbt', 'act', 'cft'], json: true, dualMode });
  return root;
}

/** 将目录中的文件名和字节哈希排序，检查 dry-run 连空目录以外文件也没有修改。 */
async function tree(root, rel = '') {
  const result = {};
  for (const item of await readdir(join(root, rel), { withFileTypes: true })) {
    const key = rel ? rel + '/' + item.name : item.name;
    if (item.isDirectory()) Object.assign(result, await tree(root, key));
    else result[key] = digest(await readFile(join(root, key)));
  }
  return result;
}

test('普通安装保持原咨询入口，不创建双模式配置', async t => {
  const root = await fixture(t);
  const body = await readFile(join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(body.includes('## 会谈启动流程'));
  assert.ok(!body.includes('inner-dialogue-dual-mode'));
  assert.equal(await readInteraction(root), null);
});

test('启用预览与状态检查完全只读', async t => {
  const root = await fixture(t), before = await tree(root);
  const preview = await enableDualMode({ path: root, dryRun: true });
  assert.equal(preview.plan.preserves_counseling, true);
  assert.deepEqual(await tree(root), before);
  assert.equal((await auditInteraction(root)).enabled, false);
});

test('原咨询入口 CRLF 与中文原始字节完整保存，临床依赖和个人资料不变', async t => {
  const root = await fixture(t);
  const old = Buffer.from((await readFile(join(root, 'CLAUDE.md'), 'utf8')).replaceAll('\n', '\r\n'), 'utf8');
  await writeFile(join(root, 'CLAUDE.md'), old);
  await writeFile(join(root, 'profile.md'), '# 背景\n\n合成事实与既有假设均须保留。\n');
  await writeFile(join(root, 'sessions/2026-10-20.md'), '# 合成既有会谈\n原记录\n');
  await writeFile(join(root, 'context/index.md'), '# 合成背景索引\n');
  const before = await tree(root);
  const result = await enableDualMode({ path: root });
  assert.ok(result.backup);
  assert.deepEqual(await readFile(join(root, '.therapy/modes/counseling.md')), old);
  assert.equal(result.counseling_sha256, digest(old));
  for (const [rel, hash] of Object.entries(before)) {
    if (rel === 'CLAUDE.md' || rel === '.claude/settings.json') continue;
    assert.equal(digest(await readFile(join(root, rel))), hash, rel);
  }
  assert.deepEqual((await auditInteraction(root)).errors, []);
  const cfg = await readInteraction(root);
  assert.equal(Object.keys(cfg.files).length, 12);
});

test('安装选项可直接启用双模式，普通安装参数仍有效', async t => {
  const root = await fixture(t, true);
  assert.equal((await auditInteraction(root)).enabled, true);
  assert.ok((await readFile(join(root, 'CLAUDE.md'), 'utf8')).includes('inner-dialogue-dual-mode: 1'));
});

test('重复启用不重复注册钩子，咨询基线不重新采样', async t => {
  const root = await fixture(t, true), before = await tree(root);
  await enableDualMode({ path: root });
  assert.deepEqual(await tree(root), before);
  const settings = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse']) {
    const count = settings.hooks[event].flatMap(g => g.hooks).filter(h => JSON.stringify(h).includes('session-mode.cjs')).length;
    assert.equal(count, 1);
  }
});

test('双模式 update 即使 force 也只处理朋友扩展，不覆盖临床配置', async t => {
  const root = await fixture(t, true), before = await tree(root);
  const result = await update({ path: root, force: true });
  assert.equal(result.plan.action, 'refresh-friend-extension');
  assert.equal(result.plan.preserves_counseling, true);
  assert.deepEqual(await tree(root), before);
});

test('朋友人格的本地自定义在更新时保留', async t => {
  const root = await fixture(t, true);
  const file = join(root, '.therapy/friend-personas/light-humor.md');
  await writeFile(file, '# 用户自定义朋友风格\n');
  const result = await update({ path: root, force: true });
  assert.ok(result.plan.skipped_user_edited.includes('.therapy/friend-personas/light-humor.md'));
  assert.equal(await readFile(file, 'utf8'), '# 用户自定义朋友风格\n');
});

test('咨询资产发生变化时检查和更新明确报错，不偷偷替换基线', async t => {
  const root = await fixture(t, true), cfg = await readInteraction(root);
  await writeFile(join(root, '.therapy/modalities/cbt.md'), '外部修改\n');
  assert.ok((await auditInteraction(root)).errors.some(e => e.includes('cbt.md')));
  await assert.rejects(update({ path: root }), /咨询基线不一致/);
  assert.equal((await readInteraction(root)).protected_files['.therapy/modalities/cbt.md'], cfg.protected_files['.therapy/modalities/cbt.md']);
});

test('停用预览不写入，停用后逐字恢复入口和未改变的原设置', async t => {
  const root = await fixture(t);
  const entry = await readFile(join(root, 'CLAUDE.md'));
  const settings = await readFile(join(root, '.claude/settings.json'));
  await enableDualMode({ path: root });
  const before = await tree(root);
  await disableDualMode({ path: root, dryRun: true });
  assert.deepEqual(await tree(root), before);
  await disableDualMode({ path: root });
  assert.deepEqual(await readFile(join(root, 'CLAUDE.md')), entry);
  assert.deepEqual(await readFile(join(root, '.claude/settings.json')), settings);
  assert.equal((await auditInteraction(root)).enabled, false);
  await enableDualMode({ path: root });
  assert.equal((await auditInteraction(root)).enabled, true);
});

test('停用保留后来增加的其他设置和钩子', async t => {
  const root = await fixture(t, true), file = join(root, '.claude/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.extraPreference = '保留';
  settings.hooks.PreToolUse.push({ matcher: 'Read', hooks: [{ type: 'command', command: 'user-hook' }] });
  await writeFile(file, JSON.stringify(settings));
  await disableDualMode({ path: root });
  const final = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(final.extraPreference, '保留');
  assert.equal(final.hooks.PreToolUse[0].hooks[0].command, 'user-hook');
  assert.ok(!JSON.stringify(final).includes('session-mode.cjs'));
});

test('损坏设置和损坏元数据不能被启用操作覆盖', async t => {
  const root = await fixture(t), entry = await readFile(join(root, 'CLAUDE.md'));
  await writeFile(join(root, '.claude/settings.json'), '{ broken');
  await assert.rejects(enableDualMode({ path: root }));
  assert.deepEqual(await readFile(join(root, 'CLAUDE.md')), entry);
  await writeFile(join(root, '.therapy/interaction.json'), '{ broken');
  await assert.rejects(readInteraction(root));
});

test('已有未知扩展目标时停止，避免覆盖自定义资料', async t => {
  const root = await fixture(t);
  await mkdir(join(root, '.therapy/modes'), { recursive: true });
  await writeFile(join(root, '.therapy/modes/friend.md'), '既有自定义内容');
  await assert.rejects(enableDualMode({ path: root }), /未受管理/);
  assert.equal(await readFile(join(root, '.therapy/modes/friend.md'), 'utf8'), '既有自定义内容');
});

test('doctor 同时验证模式钩子和原咨询基线', async t => {
  const root = await fixture(t, true);
  const result = await doctor({ path: root, claudeVersionOutput: null, runHookProbe: null });
  assert.equal(result.errors.length, 0);
  assert.ok(result.checks.includes('双模式入口、锁定钩子及原咨询基线完整'));
});

test('模式钩子合并保留原有条目，拒绝畸形 hooks', () => {
  const old = { custom: 7, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } };
  const next = mergeModeHooks(JSON.stringify(old));
  assert.equal(next.custom, 7);
  assert.deepEqual(next.hooks.UserPromptSubmit[0], old.hooks.UserPromptSubmit[0]);
  assert.deepEqual(mergeModeHooks(JSON.stringify(next)), next);
  assert.throws(() => mergeModeHooks('{"hooks":[]}'), /结构异常/);
});

// 已知朋友资产丢失时可恢复，但仍不能重建或重新采样咨询原文。
test('更新修复丢失朋友文件与模式钩子，同时维持咨询基线', async t => {
  const root = await fixture(t, true), before = await readFile(join(root, '.therapy/modes/counseling.md'));
  await unlink(join(root, '.therapy/friend-lengths/deep.md'));
  const file = join(root, '.claude/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  delete settings.hooks.PreToolUse;
  await writeFile(file, JSON.stringify(settings));
  const result = await update({ path: root });
  assert.ok(result.plan.writes.includes('.therapy/friend-lengths/deep.md'));
  assert.deepEqual((await auditInteraction(root)).errors, []);
  assert.deepEqual(await readFile(join(root, '.therapy/modes/counseling.md')), before);
});
