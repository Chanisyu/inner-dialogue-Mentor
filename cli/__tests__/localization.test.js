import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from '../install.js';
import { update } from '../update.js';
import { doctor } from '../doctor.js';
import { PACKAGE_ROOT } from '../lib/paths.js';

// 覆盖真实安装、启用副本、库文件和更新，而非只检查单独的翻译函数。
// 临时目录不读取 Willow 的个人资料，模型探针通过测试接缝显式关闭。
test('中文安装完整生成库文件，并在更新时保留咨询记录和本地修改', async () => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'inner-dialogue-zh-'));
  try {
    const modalities = (await readdir(join(PACKAGE_ROOT, 'modalities')))
      .filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3));
    await install({ name: '中文测试咨询师', path: root, persona: 'warm-4o',
      structure: 'moderate', modalities, json: true });

    const read = (relative) => readFile(join(root, relative), 'utf8');
    assert.match(await read('CLAUDE.md'), /中文测试咨询师/);
    assert.match(await read('CLAUDE.md'), /会谈启动流程/);
    assert.match(await read('.therapy/persona.md'), /温暖自然型/);
    assert.match(await read('.therapy/session-structure.md'), /适中结构/);
    assert.equal(await read('profile.md'), await readFile(join(PACKAGE_ROOT, 'profile.template.md'), 'utf8'));
    const registry = JSON.parse(await read('.therapy/version.json'));
    assert.equal(registry.locale, 'zh-CN');
    assert.equal(registry.source_path, PACKAGE_ROOT);
    assert.match(await read('.therapy/commands.md'), /source_path/);
    assert.doesNotMatch(await read('.therapy/commands.md'), /npx inner-dialogue@latest/);

    // 每一种可选择内容都必须是中文，且启用文件与安装库完全一致。
    for (const [kind, count] of [['personas', 8], ['modalities', 13], ['structures', 3]]) {
      const files = await readdir(join(root, '.therapy', 'library', kind));
      assert.equal(files.filter((name) => name.endsWith('.md')).length, count);
      for (const name of files.filter((name) => name.endsWith('.md'))) {
        const content = await read(`.therapy/library/${kind}/${name}`);
        assert.match(content, /[\u4e00-\u9fff]/u, name);
        assert.doesNotMatch(content, /\ufffd/u, name);
        if (kind === 'modalities') assert.equal(await read(`.therapy/modalities/${name}`), content);
      }
    }

    // 三个中文种子标题也应有效，不能依赖“四个标题就不校验”的旧捷径。
    const profile = '# 测试档案\n\n## 背景\n\n## 当前关注\n\n## 备注\n';
    await writeFile(join(root, 'profile.md'), profile, 'utf8');
    const check = await doctor({ path: root, claudeVersionOutput: null, runHookProbe: null });
    assert.equal(check.ok, true);
    assert.deepEqual(check.warnings, []);
    const preview = await update({ path: root, dryRun: true });
    assert.equal(preview.plan.updates.length, 0);
    assert.equal(preview.plan.new_files.length, 0);

    const notes = '# 会谈：2026-10-19\n\n## 关键主题\n测试记录。\n';
    await writeFile(join(root, 'sessions', '2026-10-19.md'), notes, 'utf8');
    const custom = (await read('.therapy/persona.md')) + '\n用户自定义：详细说明。\n';
    await writeFile(join(root, '.therapy', 'persona.md'), custom, 'utf8');
    const result = await update({ path: root });
    assert.ok(result.plan.skipped_user_edited.some((item) => item.path === '.therapy/persona.md'));
    assert.equal(await read('.therapy/persona.md'), custom);
    assert.equal(await read('profile.md'), profile);
    assert.equal(await read('sessions/2026-10-19.md'), notes);

    // 子进程仅保留 Node 所在目录的 PATH，确保此检查不能启动真实 Claude
    // 或发送任何模型请求。JSON 字段不变，但面向用户的检查文本应为中文。
    const cli = spawnSync(process.execPath,
      [join(PACKAGE_ROOT, 'bin', 'inner-dialogue.js'), 'doctor', '--path', root, '--json'],
      { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: dirname(process.execPath) } });
    assert.equal(cli.status, 0, cli.stderr);
    const shown = JSON.parse(cli.stdout);
    assert.equal(shown.ok, true);
    assert.ok(shown.checks.every((message) => /[\u4e00-\u9fff]/u.test(message)));
  } finally {
    // 递归清理前核对解析后的绝对目录，目标只能是本测试创建的临时子目录。
    assert.equal(dirname(resolve(root)), parent);
    assert.ok(basename(root).startsWith('inner-dialogue-zh-'));
    await rm(root, { recursive: true, force: true });
  }
});
