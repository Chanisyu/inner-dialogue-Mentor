/**
 * 可选双模式的安装、预览、审计和回滚。
 * 核心约束：原咨询入口逐字归档，咨询依赖冻结；只维护朋友扩展文件。
 * 个人资料不参与框架更新或迁移重写，朋友记忆仍由明确的保存请求驱动。
 */
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { packageFile } from './paths.js';
import modeRuntime from '../../hooks/session-mode.cjs';
import { mergeRuntimeHooks } from './runtime-logging.js';

export const INTERACTION_CONFIG = '.therapy/interaction.json';
const SNAPSHOT = '.therapy/modes/counseling.md';
const MARKER = 'session-mode.cjs';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'];
const PROTECTED = ['.therapy/persona.md', '.therapy/session-structure.md', '.therapy/safety-protocol.md', '.therapy/commands.md', '.therapy/profile-protocol.md', '.therapy/usage-reflection.md', '.therapy/hooks/safety-net.js', '.therapy/hooks/usage-stats.js'];

/** 哈希原始字节，不做换行、编码或 Markdown 归一化。 */
export function digest(content) { return createHash('sha256').update(content).digest('hex'); }

/** JSON 配置缺失与损坏分开处理；不把损坏配置当首次启用覆盖。 */
export async function readInteraction(root) {
  const p = join(root, INTERACTION_CONFIG);
  if (!existsSync(p)) return null;
  const value = JSON.parse(await readFile(p, 'utf8'));
  if (value.schema_version !== 1 || typeof value.enabled !== 'boolean' || !value.files || !value.protected_files) throw new Error('双模式配置结构损坏。');
  return value;
}

/** 配置只能引用项目内相对路径；拒绝越界路径成为读写或恢复目标。 */
function inside(root, rel) {
  if (typeof rel !== 'string' || isAbsolute(rel)) throw new Error('配置中的路径必须为相对路径。');
  const out = resolve(root, rel);
  const delta = relative(resolve(root), out);
  if (!delta || delta === '..' || delta.startsWith('../') || delta.startsWith('..\\') || isAbsolute(delta)) throw new Error('配置路径越出项目目录。');
  return out;
}

/** 只在同目录临时写入再替换完整文件，避免中断后留下半个 JSON。 */
async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, content);
  try { await rename(temp, path); }
  catch (err) {
    // 临时文件不含聊天正文；删除范围始终是此函数创建的单一确切路径。
    const { unlink } = await import('node:fs/promises');
    await unlink(temp).catch(() => {});
    throw err;
  }
}

/** 取现有咨询名字用于朋友模块，原咨询正文的名字绝不替换。 */
function therapistName(text) {
  const heading = text.split(/\r?\n/).find(l => l.startsWith('# ')) || '# Sage';
  return heading.slice(2).split(/\s+[—–]\s+|\s+-\s+AI/)[0].trim() || 'Sage';
}

/** 读取本扩展的固定资产清单；不纳入任何个人资料或咨询依赖源文件。 */
async function extensionAssets(name) {
  const pairs = [
    ['interaction/entry.template.md', 'CLAUDE.md'],
    ['interaction/friend.md', '.therapy/modes/friend.md'],
    ['interaction/friend-memory.md', '.therapy/friend-memory.md'],
    ['hooks/session-mode.cjs', '.therapy/hooks/session-mode.cjs'],
    ['hooks/runtime-log.cjs', '.therapy/hooks/runtime-log.cjs'],
    ...modeRuntime.PERSONAS.map(p => ['interaction/personas/' + p + '.md', '.therapy/friend-personas/' + p + '.md']),
    ...modeRuntime.LENGTHS.map(p => ['interaction/lengths/' + p + '.md', '.therapy/friend-lengths/' + p + '.md']),
  ];
  const assets = [];
  for (const [source, target] of pairs) {
    const raw = await readFile(packageFile(source));
    const content = source.endsWith('.md') ? Buffer.from(raw.toString('utf8').replaceAll('{{THERAPIST_NAME}}', name), 'utf8') : raw;
    assets.push({ source, target, content, hash: digest(content) });
  }
  return assets;
}

/** 校验设置形状后只追加本功能钩子，保留全部既有配置和钩子顺序。 */
export function mergeModeHooks(raw) {
  const settings = JSON.parse(raw);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json 必须是对象。');
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('hooks 配置结构异常。');
  settings.hooks = settings.hooks || {};
  for (const event of EVENTS) {
    const groups = settings.hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) throw new Error('hooks.' + event + ' 必须是数组。');
    const present = (groups || []).some(g => Array.isArray(g.hooks) && g.hooks.some(h => String(h.command || '').includes(MARKER) || (Array.isArray(h.args) && h.args.some(a => String(a).includes(MARKER)))));
    if (present) continue;
    const matcher = event === 'SessionStart' ? 'startup|resume|clear|compact' : event === 'PreToolUse' ? 'Read|Glob|Grep|Bash|Write|Edit|MultiEdit|NotebookEdit' : '';
    settings.hooks[event] = [...(groups || []), { matcher, hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.therapy/hooks/session-mode.cjs'] }] }];
  }
  return settings;
}

/** 停用只移除明确引用本脚本的项，不删除其他插件注册或后续用户配置。 */
function removeModeHooks(settings) {
  for (const event of EVENTS) {
    if (!Array.isArray(settings.hooks?.[event])) continue;
    settings.hooks[event] = settings.hooks[event].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !String(h.command || '').includes(MARKER) && !(Array.isArray(h.args) && h.args.some(a => String(a).includes(MARKER)))) })).filter(g => g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  return settings;
}

/** 审计咨询基线与入口完整性；朋友自定义内容单独报告，不升级成咨询结论。 */
export async function auditInteraction(root) {
  const value = await readInteraction(root);
  if (!value?.enabled) return { enabled: false, errors: [], warnings: [] };
  const errors = [], warnings = [];
  for (const [rel, hash] of Object.entries(value.protected_files)) {
    const p = inside(root, rel);
    if (!existsSync(p) || digest(await readFile(p)) !== hash) errors.push('咨询基线不一致：' + rel);
  }
  const main = join(root, 'CLAUDE.md');
  if (!existsSync(main) || digest(await readFile(main)) !== value.files['CLAUDE.md']) errors.push('双模式入口已被修改或缺失。');
  for (const [rel, hash] of Object.entries(value.files)) {
    if (rel === 'CLAUDE.md') continue;
    const p = inside(root, rel);
    if (!existsSync(p)) errors.push('双模式文件缺失：' + rel);
    else if (digest(await readFile(p)) !== hash) warnings.push('朋友扩展文件有本地修改：' + rel);
  }
  try {
    const raw = await readFile(join(root, '.claude/settings.json'), 'utf8');
    const current = JSON.parse(raw);
    if (JSON.stringify(mergeModeHooks(raw)) !== JSON.stringify(current)) errors.push('模式钩子注册不完整。');
    if (current.disableAllHooks === true) errors.push('项目配置禁用了全部钩子。');
  } catch (err) { errors.push('钩子配置不可用：' + err.message); }
  return { enabled: true, errors, warnings, counseling_sha256: value.counseling_sha256, extension_version: value.extension_version };
}

/**
 * 启用时先制定所有写入计划，再备份并部署；失败会恢复入口与设置。
 * 重复启用转为朋友扩展更新，绝不重新采样咨询基线掩盖已有变动。
 */
export async function enableDualMode(opts) {
  const root = resolve(opts.path);
  const previous = await readInteraction(root);
  if (previous?.enabled) return refreshDualMode(opts);
  const entry = await readFile(join(root, 'CLAUDE.md'));
  if (!existsSync(join(root, '.therapy/version.json'))) throw new Error('请先安装咨询师目录，再启用双模式。');
  const settingsPath = join(root, '.claude/settings.json');
  const settingsRaw = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : '{}\n';
  // 日志观察独立于咨询基线，不修改受保护的原安全或使用统计脚本。
  const merged = mergeRuntimeHooks(JSON.stringify(mergeModeHooks(settingsRaw)));
  if (merged.disableAllHooks === true) throw new Error('项目禁用了钩子，不能可靠启用对话锁定。');
  const name = therapistName(entry.toString('utf8'));
  const assets = await extensionAssets(name);
  const targets = [...assets, { target: SNAPSHOT, content: entry, hash: digest(entry) }];
  for (const asset of targets) {
    const p = join(root, asset.target);
    if (asset.target === 'CLAUDE.md' || !existsSync(p)) continue;
    const hash = digest(await readFile(p));
    const managedBefore = previous?.files?.[asset.target] || previous?.protected_files?.[asset.target];
    if (hash !== asset.hash && hash !== managedBefore) throw new Error('目标已有未受管理的内容，已停止：' + asset.target);
  }
  const plan = { action: 'enable', writes: targets.map(a => a.target).concat(['.claude/settings.json', INTERACTION_CONFIG]), preserves_counseling: true };
  if (opts.dryRun) return { ok: true, kind: 'dual-mode', dry_run: true, plan };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const backupRel = '.therapy/dual-mode-backups/' + stamp;
  const backup = join(root, backupRel);
  await mkdir(join(backup, '.claude'), { recursive: true });
  await writeFile(join(backup, 'CLAUDE.md'), entry);
  await writeFile(join(backup, '.claude/settings.json'), settingsRaw, 'utf8');
  const protectedFiles = { [SNAPSHOT]: digest(entry) };
  const modalityDir = join(root, '.therapy/modalities');
  const protectedPaths = [...PROTECTED, ...(existsSync(modalityDir) ? (await readdir(modalityDir)).filter(n => n.endsWith('.md')).map(n => '.therapy/modalities/' + n) : [])];
  for (const rel of protectedPaths) if (existsSync(join(root, rel))) protectedFiles[rel] = digest(await readFile(join(root, rel)));
  const next = { schema_version: 1, enabled: true, extension_version: '1.0.0', therapist: name, created_at: new Date().toISOString(), backup_relative: backupRel, counseling_sha256: digest(entry), protected_files: protectedFiles, files: Object.fromEntries(assets.map(a => [a.target, a.hash])) };
  try {
    // 先部署依赖与原文副本，最后切换入口；新窗口不会读到缺失依赖的路由。
    for (const a of targets.filter(a => a.target !== 'CLAUDE.md')) await atomicWrite(join(root, a.target), a.content);
    await atomicWrite(join(root, INTERACTION_CONFIG), JSON.stringify(next, null, 2) + '\n');
    await atomicWrite(settingsPath, JSON.stringify(merged, null, 2) + '\n');
    await atomicWrite(join(root, 'CLAUDE.md'), assets.find(a => a.target === 'CLAUDE.md').content);
    const audit = await auditInteraction(root);
    if (audit.errors.length) throw new Error(audit.errors.join('\n'));
  } catch (err) {
    await atomicWrite(join(root, 'CLAUDE.md'), entry);
    await atomicWrite(settingsPath, settingsRaw);
    if (previous) await atomicWrite(join(root, INTERACTION_CONFIG), JSON.stringify(previous, null, 2) + '\n');
    else { const { unlink } = await import('node:fs/promises'); await unlink(join(root, INTERACTION_CONFIG)).catch(() => {}); }
    throw err;
  }
  return { ok: true, kind: 'dual-mode', enabled: true, backup, plan, counseling_sha256: next.counseling_sha256, message: '双模式已启用；原咨询入口逐字保留。请使用新对话选择模式。' };
}

/**
 * 双模式启用后的 update 只刷新未被用户修改的朋友资产。
 * 咨询正文与依赖冻结；即使 --force 也不借此覆盖咨询基线或朋友自定义。
 */
export async function refreshDualMode(opts) {
  const root = resolve(opts.path);
  const cfg = await readInteraction(root);
  if (!cfg?.enabled) throw new Error('此目录没有启用双模式。');
  const audit = await auditInteraction(root);
  // 丢失的朋友文件和缺失的模式注册可以从已知资产恢复；咨询基线变化不能自动修复。
  const fatal = audit.errors.filter(e => !e.startsWith('双模式文件缺失：') && e !== '模式钩子注册不完整。' && !(e === '双模式入口已被修改或缺失。' && !existsSync(join(root, 'CLAUDE.md'))));
  if (fatal.length) throw new Error(fatal.join('\n'));
  const settingsPath = join(root, '.claude/settings.json');
  const settingsRaw = await readFile(settingsPath, 'utf8');
  const mergedSettings = mergeRuntimeHooks(JSON.stringify(mergeModeHooks(settingsRaw)));
  const repairHooks = JSON.stringify(mergedSettings) !== JSON.stringify(JSON.parse(settingsRaw));
  const assets = await extensionAssets(cfg.therapist);
  const writes = [], skipped = [];
  for (const a of assets) {
    const path = join(root, a.target);
    const current = existsSync(path) ? digest(await readFile(path)) : null;
    if (current === a.hash) continue;
    if (current && current !== cfg.files[a.target]) skipped.push(a.target);
    else writes.push(a);
  }
  const plan = { action: 'refresh-friend-extension', writes: writes.map(a => a.target).concat(repairHooks ? ['.claude/settings.json'] : []), skipped_user_edited: skipped, preserves_counseling: true };
  if (opts.dryRun) return { ok: true, kind: 'dual-mode', dry_run: true, plan };
  for (const a of writes) {
    const current = existsSync(join(root, a.target)) ? digest(await readFile(join(root, a.target))) : null;
    if (current && current !== cfg.files[a.target]) throw new Error('写入前文件已变化，停止更新：' + a.target);
    await atomicWrite(join(root, a.target), a.content);
    cfg.files[a.target] = a.hash;
  }
  if (repairHooks) await atomicWrite(settingsPath, JSON.stringify(mergedSettings, null, 2) + '\n');
  if (writes.length) await atomicWrite(join(root, INTERACTION_CONFIG), JSON.stringify(cfg, null, 2) + '\n');
  return { ok: true, kind: 'dual-mode', enabled: true, plan, message: '已检查朋友扩展；咨询正文和依赖未升级。若要升级咨询框架，先停用双模式，单独检查原框架更新，再重新启用。' };
}

/** 停用恢复咨询原文；保留状态与备份，避免删除可追溯记录。 */
export async function disableDualMode(opts) {
  const root = resolve(opts.path), cfg = await readInteraction(root);
  if (!cfg?.enabled) return { ok: true, kind: 'dual-mode', enabled: false, message: '此目录未启用双模式。' };
  const audit = await auditInteraction(root);
  if (audit.errors.some(e => e.includes(SNAPSHOT) || e.includes('入口'))) throw new Error('入口或咨询副本有变动，请先检查，不能自动覆盖。');
  const original = await readFile(join(root, SNAPSHOT));
  if (digest(original) !== cfg.counseling_sha256) throw new Error('咨询原文哈希不一致，停止恢复。');
  const settingsPath = join(root, '.claude/settings.json');
  const current = JSON.parse(await readFile(settingsPath, 'utf8'));
  const backupSettings = await readFile(join(inside(root, cfg.backup_relative), '.claude/settings.json'), 'utf8');
  const expected = mergeModeHooks(backupSettings);
  const restoredSettings = JSON.stringify(current) === JSON.stringify(expected) ? backupSettings : JSON.stringify(removeModeHooks(current), null, 2) + '\n';
  const plan = { action: 'disable', writes: ['CLAUDE.md', '.claude/settings.json', INTERACTION_CONFIG], preserves_counseling: true };
  if (opts.dryRun) return { ok: true, kind: 'dual-mode', dry_run: true, plan };
  await atomicWrite(join(root, 'CLAUDE.md'), original);
  await atomicWrite(settingsPath, restoredSettings);
  await atomicWrite(join(root, INTERACTION_CONFIG), JSON.stringify({ ...cfg, enabled: false, disabled_at: new Date().toISOString() }, null, 2) + '\n');
  return { ok: true, kind: 'dual-mode', enabled: false, plan, message: '已恢复原咨询入口并移除模式钩子；个人资料、对话状态和备份保留。' };
}

/** CLI 共用入口，状态查询只读；预览与实际启用使用同一计划。 */
export async function dualMode(opts) {
  if (opts.status) {
    const audit = await auditInteraction(resolve(opts.path));
    return { ok: !audit.errors.length, kind: 'dual-mode', ...audit, message: audit.enabled ? '双模式已启用。' : '当前为原咨询流程。' };
  }
  return opts.disable ? disableDualMode(opts) : enableDualMode(opts);
}
