/**
 * 原文归档的独立部署：普通与双模式共用，不改写已冻结的咨询提示和依赖。
 * 独立登记哈希保护自定义文件；预览完全只读，设置与忽略规则均增量合并。
 */
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { packageFile } from './paths.js';
import { hashString } from './hash.js';
import { hasHook, hookEntry, parseSettingsForMerge, writeFileAtomic } from './settings.js';

export const ARCHIVE_DESCS = ['SessionStart', 'UserPromptSubmit', 'Stop'].map(event => ({ event, matcher: event === 'SessionStart' ? 'startup|resume|clear|compact' : '', marker: 'transcript-archive.cjs', scriptRel: '.therapy/hooks/transcript-archive.cjs', label: 'transcript archive hook' }));
export const MEMORY_DESCS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'].map(event => ({ event, matcher: event === 'SessionStart' ? 'startup|resume|clear|compact' : '', marker: 'shared-memory.cjs', scriptRel: '.therapy/hooks/shared-memory.cjs', label: 'shared memory hook' }));
// 使用本机已验证的共同事件集；旧 Codex 会因未知事件拒绝整份配置，退出本来也不归档。
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'];
const ASSETS = [
  ['hooks/transcript-archive.cjs', '.therapy/hooks/transcript-archive.cjs'], ['transcript-protocol.md', '.therapy/transcript-protocol.md'],
  ['hooks/local-storage.cjs', '.therapy/hooks/local-storage.cjs'], ['hooks/codex-transcript.cjs', '.therapy/hooks/codex-transcript.cjs'],
  ['hooks/session-mode.cjs', '.therapy/hooks/session-mode.cjs'],
  ['hooks/codex-runtime.cjs', '.therapy/hooks/codex-runtime.cjs'], ['hooks/shared-memory.cjs', '.therapy/hooks/shared-memory.cjs'],
  ['hooks/usage-stats-context.cjs', '.therapy/hooks/usage-stats-context.cjs'],
  ['shared-memory-protocol.md', '.therapy/shared-memory-protocol.md'], ['client-entry.md', '.therapy/client-entry.md'],
];
const REGISTRY = '.therapy/archive-version.json';
const IGNORE = '# Inner Dialogue private transcripts\n/transcripts/\n/.therapy/archive-state/\n/.therapy/memory-state/\n/.therapy/memory-drafts/\n/.therapy/memory-journal/\n/.therapy/shared-state.json\n/.therapy/memory-*.lock\n';
const ENTRY_START = '<!-- inner-dialogue-codex-entry:start -->';
const ENTRY_END = '<!-- inner-dialogue-codex-entry:end -->';

/** 先验证三个事件再追加，保留现有钩子的顺序；不注册退出或正常回复自动保存。 */
export function mergeArchiveHooks(raw) {
  const descriptors = [...ARCHIVE_DESCS, ...MEMORY_DESCS];
  for (const desc of descriptors) { const parsed = parseSettingsForMerge(raw, desc); if (!parsed.ok) throw new Error(parsed.reason); }
  const settings = JSON.parse(raw); settings.hooks = settings.hooks || {};
  for (const desc of descriptors) if (!hasHook(settings, desc)) settings.hooks[desc.event] = [...(settings.hooks[desc.event] || []), hookEntry(desc)];
  return settings;
}

/** Codex 配置独立增量合并；保留用户钩子，不写全局配置或替换原有通知命令。 */
export function mergeCodexHooks(raw, root) {
  const settings = JSON.parse(raw);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Codex hooks.json 必须是对象。');
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Codex hooks 配置结构无效。');
  settings.hooks ||= {};
  const script = join(root, '.therapy/hooks/codex-runtime.cjs').replaceAll('\\', '/');
  if (/[\r\n"\0]/.test(script)) throw new Error('Codex 钩子路径包含不支持的字符。');
  for (const event of CODEX_EVENTS) {
    if (settings.hooks[event] !== undefined && !Array.isArray(settings.hooks[event])) throw new Error('Codex 钩子事件必须是数组：' + event);
    const present = (settings.hooks[event] || []).some(g => Array.isArray(g.hooks) && g.hooks.some(h => String(h.command || '').includes('codex-runtime.cjs')));
    if (!present) settings.hooks[event] = [...(settings.hooks[event] || []), { matcher: event === 'SessionStart' ? 'startup|resume|clear|compact|fork' : '', hooks: [{ type: 'command', command: "node '" + script.replaceAll("'", "'\\''") + "'", commandWindows: 'node "' + script + '"', timeout: 15 }] }];
  }
  return settings;
}

/** 已存在但损坏的登记不能按新安装覆盖；未知的资产也不能擅自覆盖。 */
export async function archivePlan(root, options = {}) {
  const file = join(root, REGISTRY);
  const registry = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { schema: 1, files: {} };
  if (registry.schema !== 1 || !registry.files || typeof registry.files !== 'object' || Array.isArray(registry.files)) throw new Error('原文归档安装登记损坏。');
  const assets = [], writes = [], skipped = [];
  let registerMatching = false;
  for (const [source, target] of ASSETS) {
    // 双模式协调器会先发布已验证的共用资产；预览不要将这些旧版本误报为用户修改。
    // 真正应用仍重新读取磁盘和登记，不借预览参数绕过资产保护。
    if (options.deferAssets?.includes(target)) continue;
    const content = await readFile(packageFile(source), 'utf8'), hash = hashString(content), path = join(root, target);
    const current = existsSync(path) ? hashString(await readFile(path, 'utf8')) : null;
    if (current === hash) {
      // 文件已与发行版本一致时只补登记，不重新写正文，也不把它误判为自定义资产。
      if (registry.files[target] !== hash) { registry.files[target] = hash; registerMatching = true; }
      continue;
    }
    if (current && current !== registry.files[target]) { skipped.push(target); continue; }
    assets.push({ target, content, hash }); writes.push(target);
  }
  // 入口使用可识别区块，用户原有 AGENTS.md 原字节保留；区块自定义后停止自动替换。
  const entryPath = join(root, 'AGENTS.md'), originalEntry = existsSync(entryPath) ? await readFile(entryPath, 'utf8') : '';
  const entry = ENTRY_START + '\n' + await readFile(packageFile('AGENTS.therapy.template.md'), 'utf8') + '\n' + ENTRY_END;
  const start = originalEntry.indexOf(ENTRY_START), end = originalEntry.indexOf(ENTRY_END);
  let newEntry = originalEntry;
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) skipped.push('AGENTS.md');
  else if (start < 0) newEntry = originalEntry + (originalEntry && !originalEntry.endsWith('\n') ? '\n' : '') + entry + '\n';
  else {
    const previous = originalEntry.slice(start, end + ENTRY_END.length), hash = hashString(previous);
    if (previous !== entry && hash !== registry.files['AGENTS.md#codex-entry']) skipped.push('AGENTS.md');
    else newEntry = originalEntry.slice(0, start) + entry + originalEntry.slice(end + ENTRY_END.length);
  }
  if (newEntry !== originalEntry) writes.push('AGENTS.md');
  if (!skipped.includes('AGENTS.md') && registry.files['AGENTS.md#codex-entry'] !== hashString(entry)) { registry.files['AGENTS.md#codex-entry'] = hashString(entry); registerMatching = true; }
  const settingsPath = join(root, '.claude/settings.json'), raw = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : '{}';
  let settings, settingsError;
  try { settings = mergeArchiveHooks(raw); } catch (err) { settingsError = err.message; }
  // 未受管理或自定义的归档脚本不自动新增执行入口，避免注册与实际代码不一致。
  if (skipped.length) { settings = null; settingsError = '归档资产有本地修改，已保留且未新增归档钩子。'; }
  if (settings && JSON.stringify(settings) !== JSON.stringify(JSON.parse(raw))) writes.push('.claude/settings.json');
  const codexPath = join(root, '.codex/hooks.json'), codexRaw = existsSync(codexPath) ? await readFile(codexPath, 'utf8') : '{}';
  let codexSettings, codexError;
  try {
    const config = join(root, '.codex/config.toml');
    if (existsSync(config) && /^\s*\[hooks(?:\.|\])/m.test(await readFile(config, 'utf8'))) throw new Error('已有内联 Codex hooks 配置，已保留；请先统一配置来源后接入。');
    codexSettings = mergeCodexHooks(codexRaw, root);
    if (skipped.length) throw new Error('归档或共享组件有本地修改，未新增 Codex 执行入口。');
  } catch (err) { codexSettings = null; codexError = err.message; }
  if (codexSettings && JSON.stringify(codexSettings) !== JSON.stringify(JSON.parse(codexRaw))) writes.push('.codex/hooks.json');
  const ignoreFile = join(root, '.gitignore'), ignore = existsSync(ignoreFile) ? await readFile(ignoreFile, 'utf8') : '';
  const lines = ignore.split(/\r?\n/);
  const missing = IGNORE.trimEnd().split('\n').filter(line => !line.startsWith('#') && !lines.includes(line));
  const newIgnore = missing.length ? ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + '# Inner Dialogue private transcripts\n' + missing.join('\n') + '\n' : ignore;
  if (newIgnore !== ignore) writes.push('.gitignore');
  if (!existsSync(file) || assets.length || registerMatching) writes.push(REGISTRY);
  return { writes, skipped, settingsError, codexError, assets, registry, settings, raw, codexSettings, codexRaw, newEntry, originalEntry, newIgnore, ignore };
}

/** 应用前重新制定计划，确保不会用旧预览覆盖用户刚改过的资产；配置修改先备份。 */
export async function applyArchiving(root) {
  const plan = await archivePlan(root);
  let backup;
  for (const asset of plan.assets) {
    const target = join(root, asset.target); await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, asset.content); plan.registry.files[asset.target] = asset.hash;
  }
  if (plan.writes.includes('.claude/settings.json')) {
    const path = join(root, '.claude/settings.json');
    if (existsSync(path)) { backup = path + '.bak-archive-' + randomUUID(); await copyFile(path, backup); }
    await mkdir(dirname(path), { recursive: true }); await writeFileAtomic(path, JSON.stringify(plan.settings, null, 2) + '\n');
  }
  let codexBackup;
  if (plan.writes.includes('.codex/hooks.json')) {
    const path = join(root, '.codex/hooks.json');
    if (existsSync(path)) { codexBackup = path + '.bak-' + randomUUID(); await copyFile(path, codexBackup); }
    await mkdir(dirname(path), { recursive: true }); await writeFileAtomic(path, JSON.stringify(plan.codexSettings, null, 2) + '\n');
  }
  if (plan.newEntry !== plan.originalEntry) await writeFileAtomic(join(root, 'AGENTS.md'), plan.newEntry);
  if (plan.newIgnore !== plan.ignore) await writeFileAtomic(join(root, '.gitignore'), plan.newIgnore);
  if (plan.writes.includes(REGISTRY)) await writeFileAtomic(join(root, REGISTRY), JSON.stringify(plan.registry, null, 2) + '\n');
  return { writes: plan.writes, skipped: plan.skipped, ...(backup ? { backup } : {}), ...(codexBackup ? { codex_backup: codexBackup } : {}), ...(plan.settingsError ? { settings_error: plan.settingsError } : {}), ...(plan.codexError ? { codex_error: plan.codexError } : {}) };
}
