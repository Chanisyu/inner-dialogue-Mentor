import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PACKAGE_ROOT } from './paths.js';

export async function readVersionJson(path) {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeVersionJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// 记录本地中文工具包的来源，供咨询目录中的更新指令定位相同版本。
// 此处只保存工具包路径，不复制任何来访者档案或咨询记录。
export function emptyVersionJson(kitVersion, sourceUrl) {
  return {
    kit_version: kitVersion,
    locale: 'zh-CN',
    source_path: PACKAGE_ROOT,
    installed: new Date().toISOString().slice(0, 10),
    files: {},
    source_url: sourceUrl || 'https://github.com/ataglianetti/inner-dialogue',
  };
}

export function recordFile(versionData, relPath, fileVersion, hash, sourceRel) {
  versionData.files = versionData.files || {};
  versionData.files[relPath] = {
    version: fileVersion,
    hash,
    source: sourceRel,
  };
}
