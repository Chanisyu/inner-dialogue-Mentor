// <!-- version: 1.0.0 -->
/**
 * 跨客户端共用的本地存储工具。所有私有输出限定在咨询根目录，拒绝链接和越界。
 * 临时文件只在同目录创建，发布使用重命名；清理仅针对本次创建的确切文件。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const CRYPTO = require('node:crypto');

/** 内部会话与事务使用 UUID，客户端原生标识另行登记，不直接成为输出路径。 */
function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) throw new Error('缺少有效的内部会话或事务标识。');
  return value.toLowerCase();
}

/** 检查路径的每一级，防止普通文件、目录链接或 Windows 路径格式造成越界。 */
function inside(root, rel) {
  if (typeof rel !== 'string' || /[\0\r\n]/.test(rel)) throw new Error('无效的项目内路径。');
  const base = PATH.resolve(root), file = PATH.resolve(base, rel), delta = PATH.relative(base, file);
  if (!delta || delta === '..' || delta.startsWith('..' + PATH.sep) || PATH.isAbsolute(delta)) throw new Error('存储路径越出咨询目录。');
  let current = base;
  for (const part of delta.split(PATH.sep)) {
    current = PATH.join(current, part);
    try { if (FS.lstatSync(current).isSymbolicLink()) throw new Error('存储路径不能经过链接。'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return file;
}

/** 私人正文使用受限权限；不把内容放进命令行、日志或公共临时目录。 */
function atomic(file, body) {
  FS.mkdirSync(PATH.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + CRYPTO.randomUUID() + '.tmp';
  try { FS.writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); FS.renameSync(temp, file); }
  finally { if (FS.existsSync(temp)) FS.unlinkSync(temp); }
}
function json(file, value) { atomic(file, JSON.stringify(value, null, 2) + '\n'); }
function read(file) { return JSON.parse(FS.readFileSync(file, 'utf8')); }
function hash(text) { return CRYPTO.createHash('sha256').update(text).digest('hex'); }

/** 有界读取 stdin；钩子和命令都不能因没有输入而无限等待。 */
async function input(limit = 2 * 1024 * 1024) {
  let raw = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error('本地工具输入超时。')); }, 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; if (raw.length > limit) { clearTimeout(timer); process.stdin.destroy(); reject(new Error('本地工具输入过大。')); } });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(); });
    process.stdin.on('error', err => { clearTimeout(timer); reject(err); });
  });
  return JSON.parse(raw);
}
module.exports = { uuid, inside, atomic, json, read, hash, input };
