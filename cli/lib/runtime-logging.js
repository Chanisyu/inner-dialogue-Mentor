/**
 * 统一日志钩子的整组注册：一次校验、一次备份、一次写入，保留既有钩子及其顺序。
 * 预览不创建文件；损坏配置保留原样，不用日志功能覆盖用户设置。
 */
import { readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import runtimeLog from '../../hooks/runtime-log.cjs';
import { hasHook, hookEntry, parseSettingsForMerge, writeFileAtomic, SETTINGS_REL_PATH } from './settings.js';

/** 每个事件共用同一只读观察脚本，按事件分别去重，避免重复记录。 */
export const RUNTIME_LOG_DESCS = runtimeLog.EVENTS.map(event => ({
  event, matcher: event === 'SessionStart' ? 'startup|resume|clear|compact' : '',
  marker: 'runtime-log.cjs', scriptRel: '.therapy/hooks/runtime-log.cjs', label: 'runtime log hook',
}));

/** 完整验证全部目标事件后再追加；返回新对象，不修改调用方用于比较的设置。 */
export function mergeRuntimeHooks(raw) {
  for (const desc of RUNTIME_LOG_DESCS) {
    const parsed = parseSettingsForMerge(raw, desc);
    if (!parsed.ok) throw new Error(parsed.reason);
  }
  const settings = JSON.parse(raw);
  settings.hooks = settings.hooks || {};
  for (const desc of RUNTIME_LOG_DESCS) if (!hasHook(settings, desc)) settings.hooks[desc.event] = [...(settings.hooks[desc.event] || []), hookEntry(desc)];
  return settings;
}

/** 缺失设置交给初始模板；现有设置只有缺少观察事件时才需要合并。 */
export async function planRuntimeLogging(settingsPath) {
  if (!existsSync(settingsPath)) return null;
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const settings = mergeRuntimeHooks(raw);
    if (JSON.stringify(settings) === JSON.stringify(JSON.parse(raw))) return null;
    return { path: SETTINGS_REL_PATH, action: 'add_runtime_log_hooks' };
  } catch (err) { return { path: SETTINGS_REL_PATH, action: 'skipped', reason: err.message }; }
}

/** 应用时重新读取，唯一备份名防止同秒内的其他钩子合并覆盖这份恢复点。 */
export async function applyRuntimeLogging(settingsPath) {
  let backup = null;
  try {
    if (!existsSync(settingsPath)) return { merged: false, code: 'missing', reason: 'settings.json missing' };
    const raw = await readFile(settingsPath, 'utf8');
    const settings = mergeRuntimeHooks(raw);
    if (JSON.stringify(settings) === JSON.stringify(JSON.parse(raw))) return { merged: false, code: 'already_registered' };
    backup = settingsPath + '.bak-runtime-log-' + randomUUID();
    await copyFile(settingsPath, backup);
    await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { merged: true, backup };
  } catch (err) {
    return { merged: false, code: 'error', reason: `settings merge failed (${err.message})` + (backup ? `; backup: ${backup}` : '') };
  }
}
