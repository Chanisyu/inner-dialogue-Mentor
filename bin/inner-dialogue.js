#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { install } from '../cli/install.js';
import { update } from '../cli/update.js';
import { doctor } from '../cli/doctor.js';
// 双模式为可选扩展，独立命令不改变普通咨询安装的默认行为。
import { dualMode } from '../cli/lib/interaction.js';
import { packageFile } from '../cli/lib/paths.js';
import { expandHome } from '../cli/lib/paths.js';
import runtimeLog from '../hooks/runtime-log.cjs';
// 输出边界统一中文化，保留 JSON 字段及命令参数的稳定接口。
import { PERSONA_LABELS, STRUCTURE_LABELS, MODALITY_LABELS, localizeResult, zhMessage } from '../cli/lib/locale.js';

const HELP = `inner-dialogue — 本地 AI 心理支持工具包（简体中文）

用法：
  inner-dialogue install   [参数]   创建新的咨询师目录
  inner-dialogue update    [参数]   更新现有目录的框架文件
  inner-dialogue doctor    [参数]   检查目录完整性
  inner-dialogue dual-mode [参数]   预览、启用、检查或停用双模式
  inner-dialogue --version          显示版本
  inner-dialogue --help             显示帮助

安装参数：
  --name <名称>              咨询师名称，例如“柳”
  --path <目录>              保存位置，绝对路径或 ~/...
  --persona <slug>           人格，例如 warm-4o、grounded-real、coach
  --structure <slug>         structured、moderate、freeform
  --modalities <a,b,c>       疗法选项，逗号分隔，例如 cbt,ifs
  --dual-mode               安装后启用可选双模式
  --force                   在现有 .therapy/ 上重新安装
  --json                    以 JSON 输出结果

更新参数：
  --path <目录>              咨询目录，默认当前目录
  --dry-run                 仅显示计划，不写入文件
  --force                   覆盖已由用户修改的框架文件
  --json                    以 JSON 输出结果

双模式参数：
  --path <目录>              已安装的咨询师目录
  --dry-run                 预览，完全不写文件
  --status                  只读检查双模式与咨询基线
  --disable                 恢复原咨询入口
  --json                    输出结构化结果

检查参数：
  --path <目录>              咨询目录，默认当前目录
  --json                    以 JSON 输出结果

在中文项目根目录运行：
  node bin/inner-dialogue.js install --name 柳 --path ~/Willow --persona warm-4o --structure moderate --modalities cbt,ifs
  node bin/inner-dialogue.js update --path ~/Willow --dry-run
  node bin/inner-dialogue.js doctor --path ~/Willow
`;

function parseList(v) {
  if (!v) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function printSettingsMerge(merges, dryRun) {
  for (const m of merges || []) {
    // 两种钩子共用安装结果展示，不能遗漏新增的会谈使用统计注册。
    if (m.action === 'add_safety_net_hook' || m.action === 'add_usage_stats_hook' || m.action === 'add_runtime_log_hooks') {
      const label = m.action === 'add_safety_net_hook' ? '安全钩子' : m.action === 'add_usage_stats_hook' ? '使用统计钩子' : '运行日志钩子';
      process.stdout.write(
        dryRun
          ? `\n将向 .claude/settings.json 注册${label}。\n`
          : `\n已向 .claude/settings.json 注册${label}。\n` +
              (m.backup ? `  备份：${m.backup}\n` : '')
      );
    } else if (m.action === 'skipped') {
      process.stdout.write(
        `\n已跳过 .claude/settings.json：${m.reason}\n`
      );
    }
  }
}

/** 将独立归档部署结果同时展示给普通终端用户，不能只在 JSON 中暴露失败。 */
function printArchiving(archive, dryRun) {
  if (!archive) return;
  if (archive.writes?.length) process.stdout.write(dryRun ? '\n将更新原文归档与跨客户端共享组件。\n' : '\n已更新原文归档与跨客户端共享组件。\n');
  if (archive.backup) process.stdout.write('  归档设置备份：' + archive.backup + '\n');
  for (const file of archive.skipped || []) process.stdout.write('  已保留归档组件的本地修改：' + file + '\n');
  if (archive.settings_error) process.stdout.write('  归档尚未完整接入：' + archive.settings_error + '\n');
  if (archive.codex_error) process.stdout.write('  Codex 尚未完整接入：' + archive.codex_error + '\n');
  if (archive.codex_backup) process.stdout.write('  Codex 设置备份：' + archive.codex_backup + '\n');
}

function printResult(result, json) {
  // 普通文本与 JSON 的诊断内容保持同一语言，路径和状态值不变。
  // 扩展结果独立展示，避免被普通安装或旧更新结果的字段结构误识别。
  if (result.kind === 'dual-mode') {
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      if (result.dry_run) process.stdout.write('仅预览，未写入文件。\n');
      if (result.message) process.stdout.write(result.message + '\n');
      for (const file of result.plan?.writes || []) process.stdout.write('  文件：' + file + '\n');
      for (const message of [...(result.errors || []), ...(result.warnings || [])]) process.stdout.write('  检查：' + message + '\n');
      if (result.backup) process.stdout.write('  备份：' + result.backup + '\n');
      printArchiving(result.plan?.archiving, result.dry_run);
      if (result.plan?.archive_settings_error) process.stdout.write('  归档尚未完整接入：' + result.plan.archive_settings_error + '\n');
    }
    return;
  }
  result = localizeResult(result);
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (result.ok && result.path) {
    process.stdout.write(
      `\n已创建：${result.therapist}，目录：${result.path}\n` +
        `  人格：${PERSONA_LABELS[result.persona] || result.persona}（${result.persona}）\n` +
        `  结构：${STRUCTURE_LABELS[result.structure] || result.structure}（${result.structure}）\n` +
        `  疗法：${result.modalities.map((slug) => MODALITY_LABELS[slug] || slug).join('、')}\n`
    );
    printSettingsMerge(result.settings_merge);
    printArchiving(result.archiving);
    if (result.dual_mode) process.stdout.write('\n已启用双模式；新对话先选模式，朋友再选人格与篇幅。\n');
    process.stdout.write(
      `\n开始咨询：在 Claude 应用或 Codex 中打开 ${result.path} 为主目录，或进入该目录运行 \`claude\`／\`codex\`。Codex 首次使用请检查钩子信任。\n`
    );
    return;
  }
  if (result.plan) {
    const p = result.plan;
    if (result.dry_run) process.stdout.write('仅预览计划，未写入文件。\n\n');
    if (result.backup) process.stdout.write(`备份：${result.backup}\n\n`);
    if (p.updates.length) {
      process.stdout.write(`更新（${p.updates.length}）：\n`);
      for (const u of p.updates)
        process.stdout.write(`  ${u.path}  ${u.from_version ?? '?'} → ${u.to_version ?? '?'}\n`);
    }
    if (p.new_files.length) {
      process.stdout.write(`\n新增（${p.new_files.length}）：\n`);
      for (const u of p.new_files)
        process.stdout.write(`  ${u.path}  (v${u.to_version ?? '?'})\n`);
    }
    if (p.skipped_user_edited.length) {
      process.stdout.write(
        `\n已跳过并保留用户修改（${p.skipped_user_edited.length}）：\n`
      );
      for (const u of p.skipped_user_edited)
        process.stdout.write(`  ${u.path}  (${u.reason})\n`);
      process.stdout.write(
        `\n使用 --force 可覆盖以上文件，写入前会备份。\n`
      );
    }
    if (p.forced_overwrites && p.forced_overwrites.length) {
      process.stdout.write(
        `\n强制覆盖（${p.forced_overwrites.length}）：\n`
      );
      for (const u of p.forced_overwrites)
        process.stdout.write(`  ${u.path}  （原状态：${u.reason}）\n`);
    }
    if (p.legacy_removed && p.legacy_removed.length) {
      process.stdout.write(
        `\n移除旧启动器（${p.legacy_removed.length}）：\n`
      );
      for (const u of p.legacy_removed)
        process.stdout.write(`  ${u.path}\n`);
      process.stdout.write(
        `  通过 Claude 应用开始咨询，或在终端运行 \`claude\`。\n`
      );
    }
    printSettingsMerge(p.settings_merge, result.dry_run);
    printArchiving(p.archiving, result.dry_run);
    if (p.registered_on_migration && p.registered_on_migration.length) {
      process.stdout.write(
        `\n纳入新登记表（${p.registered_on_migration.length}）：\n`
      );
      process.stdout.write(
        `  这些文件已与当前工具包一致，将在 version.json 中登记哈希，\n` +
          `  便于后续更新比较，避免误报为未知来源。\n`
      );
    }
    if (result.message) process.stdout.write(`\n${result.message}\n`);
    return;
  }
  if (result.errors !== undefined || result.issues !== undefined) {
    const errs = result.errors || result.issues || [];
    const warns = result.warnings || [];

    if (errs.length === 0 && warns.length === 0) {
      process.stdout.write('全部检查通过：\n');
      for (const c of result.checks) process.stdout.write(`  ok  ${c}\n`);
      return;
    }

    if (errs.length) {
      process.stdout.write(`错误（${errs.length}）：\n`);
      for (const i of errs) process.stdout.write(`  !!  ${i}\n`);
    }
    if (warns.length) {
      process.stdout.write(
        `${errs.length ? '\n' : ''}提示（${warns.length}）：\n`
      );
      for (const w of warns) process.stdout.write(`  ~~  ${w}\n`);
    }
    if (result.checks.length) {
      process.stdout.write('\n已通过：\n');
      for (const c of result.checks) process.stdout.write(`  ok  ${c}\n`);
    }
    if (errs.length === 0 && warns.length > 0) {
      process.stdout.write(
        '\n没有结构性错误。请根据上述提示检查相应功能是否可用。\n'
      );
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    const pkg = JSON.parse(await readFile(packageFile('package.json'), 'utf8'));
    process.stdout.write(pkg.version + '\n');
    return 0;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  const commonOptions = {
    path: { type: 'string' },
    json: { type: 'boolean' },
    force: { type: 'boolean' },
  };

  let parsed;
  try {
    if (command === 'install') {
      parsed = parseArgs({
        args: rest,
        options: {
          ...commonOptions,
          name: { type: 'string' },
          'dual-mode': { type: 'boolean' },
          persona: { type: 'string' },
          structure: { type: 'string' },
          modalities: { type: 'string' },
        },
        strict: true,
      });
    } else if (command === 'update') {
      parsed = parseArgs({
        args: rest,
        options: {
          ...commonOptions,
          'dry-run': { type: 'boolean' },
        },
        strict: true,
      });
    } else if (command === 'dual-mode') {
      parsed = parseArgs({ args: rest, options: { path: { type: 'string' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, status: { type: 'boolean' }, disable: { type: 'boolean' } }, strict: true });
      if (parsed.values.status && parsed.values.disable) throw new Error('--status 与 --disable 不能同时使用');
    } else if (command === 'doctor') {
      parsed = parseArgs({
        args: rest,
        options: { path: { type: 'string' }, json: { type: 'boolean' } },
        strict: true,
      });
    } else {
      process.stderr.write(`未知命令：${command}\n\n${HELP}`);
      return 1;
    }
  } catch (err) {
    process.stderr.write(`参数错误：${zhMessage(err.message)}\n`);
    return 2;
  }

  const v = parsed.values;
  // 严格预览与状态查询不落日志，继续保持它们完全不写文件的契约。
  // 新安装尚无目标目录时允许写用户目录兜底，避免日志提前创建 .therapy 影响安装判断。
  const record = entry => {
    if (!v['dry-run'] && !v.status) runtimeLog.writeEvent(expandHome(v.path || process.cwd()), { component: 'cli', command, ...entry }, { fallback: true });
  };
  try {
    let result;
    if (command === 'install') {
      result = await install({
        name: v.name,
        path: v.path,
        persona: v.persona,
        structure: v.structure,
        modalities: parseList(v.modalities),
        dualMode: v['dual-mode'],
        force: v.force,
        json: v.json,
      });
    } else if (command === 'update') {
      result = await update({
        path: v.path || process.cwd(),
        dryRun: v['dry-run'],
        force: v.force,
      });
    } else if (command === 'dual-mode') {
      result = await dualMode({ path: v.path || process.cwd(), dryRun: v['dry-run'], status: v.status, disable: v.disable });
    } else {
      result = await doctor({ path: v.path || process.cwd() });
    }
    record({ event: result.ok === false ? 'command.failure' : 'command.complete', level: result.ok === false ? 'error' : 'info', ...(result.ok === false ? { error: { code: 'ERROR' } } : {}) });
    for (const merge of result.settings_merge || result.plan?.settings_merge || []) if (merge.action === 'skipped') record({ event: 'settings.merge_skipped', level: 'warn', error: merge.reason });
    // 与其他配置跳过一致，仅记录固定元数据，不把配置正文或用户对话写入日志。
    const archive = result.archiving || result.plan?.archiving;
    if (archive?.settings_error || archive?.codex_error || result.plan?.archive_settings_error) record({ event: 'archive.setup_incomplete', level: 'warn' });
    printResult(result, v.json);
    return result.ok === false ? 1 : 0;
  } catch (err) {
    record({ event: 'command.failure', level: 'error', error: err });
    if (v.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: zhMessage(err.message) }, null, 2) + '\n'
      );
    } else {
      process.stderr.write(`错误：${zhMessage(err.message)}\n`);
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
