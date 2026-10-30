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
const ASSETS = [['hooks/transcript-archive.cjs', '.therapy/hooks/transcript-archive.cjs'], ['transcript-protocol.md', '.therapy/transcript-protocol.md']];
const REGISTRY = '.therapy/archive-version.json';
const IGNORE = '# Inner Dialogue private transcripts\n/transcripts/\n/.therapy/archive-state/\n';

/** 先验证三个事件再追加，保留现有钩子的顺序；不注册退出或正常回复自动保存。 */
export function mergeArchiveHooks(raw) {
  for (const desc of ARCHIVE_DESCS) { const parsed = parseSettingsForMerge(raw, desc); if (!parsed.ok) throw new Error(parsed.reason); }
  const settings = JSON.parse(raw); settings.hooks = settings.hooks || {};
  for (const desc of ARCHIVE_DESCS) if (!hasHook(settings, desc)) settings.hooks[desc.event] = [...(settings.hooks[desc.event] || []), hookEntry(desc)];
  return settings;
}

/** 已存在但损坏的登记不能按新安装覆盖；未知的资产也不能擅自覆盖。 */
export async function archivePlan(root) {
  const file = join(root, REGISTRY);
  const registry = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { schema: 1, files: {} };
  if (registry.schema !== 1 || !registry.files || typeof registry.files !== 'object' || Array.isArray(registry.files)) throw new Error('原文归档安装登记损坏。');
  const assets = [], writes = [], skipped = [];
  let registerMatching = false;
  for (const [source, target] of ASSETS) {
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
  const settingsPath = join(root, '.claude/settings.json'), raw = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : '{}';
  let settings, settingsError;
  try { settings = mergeArchiveHooks(raw); } catch (err) { settingsError = err.message; }
  // 未受管理或自定义的归档脚本不自动新增执行入口，避免注册与实际代码不一致。
  if (skipped.length) { settings = null; settingsError = '归档资产有本地修改，已保留且未新增归档钩子。'; }
  if (settings && JSON.stringify(settings) !== JSON.stringify(JSON.parse(raw))) writes.push('.claude/settings.json');
  const ignoreFile = join(root, '.gitignore'), ignore = existsSync(ignoreFile) ? await readFile(ignoreFile, 'utf8') : '';
  const lines = ignore.split(/\r?\n/);
  const missing = IGNORE.trimEnd().split('\n').filter(line => !line.startsWith('#') && !lines.includes(line));
  const newIgnore = missing.length ? ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + '# Inner Dialogue private transcripts\n' + missing.join('\n') + '\n' : ignore;
  if (newIgnore !== ignore) writes.push('.gitignore');
  if (!existsSync(file) || assets.length || registerMatching) writes.push(REGISTRY);
  return { writes, skipped, settingsError, assets, registry, settings, raw, newIgnore, ignore };
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
  if (plan.newIgnore !== plan.ignore) await writeFileAtomic(join(root, '.gitignore'), plan.newIgnore);
  if (plan.writes.includes(REGISTRY)) await writeFileAtomic(join(root, REGISTRY), JSON.stringify(plan.registry, null, 2) + '\n');
  return { writes: plan.writes, skipped: plan.skipped, ...(backup ? { backup } : {}), ...(plan.settingsError ? { settings_error: plan.settingsError } : {}) };
}
