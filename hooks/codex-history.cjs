// <!-- version: 1.0.0 -->
/**
 * 通过本机 Codex App Server 的只读接口读取完整分页历史。
 * 只允许初始化、读取元数据和分页；不恢复会话、不调用模型、不发送消息或修改客户端数据。
 * 以独立 Node 工作进程隔离异步协议，供同步 Stop 钩子调用；正文只经管道传递，不写临时文件。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const CP = require('node:child_process');

/** 优先使用桌面客户端提供的原生程序；Windows 不通过 shell 执行 npm 的 cmd 包装器。 */
function executable() {
  const explicit = process.env.CODEX_APP_RUNTIME_CLI_PATH || process.env.INNER_DIALOGUE_CODEX_CLI;
  if (explicit) {
    if (!PATH.isAbsolute(explicit) || !FS.statSync(explicit).isFile()) throw new Error('Codex 本机程序路径无效。');
    return explicit;
  }
  if (process.platform !== 'win32') return 'codex';
  for (const dir of (process.env.PATH || '').split(PATH.delimiter)) {
    const file = PATH.join(dir, 'codex.exe');
    if (FS.existsSync(file) && FS.statSync(file).isFile()) return file;
  }
  throw new Error('完整分页历史需要本机 Codex；请提供 CODEX_APP_RUNTIME_CLI_PATH 或 INNER_DIALOGUE_CODEX_CLI。');
}

/** 分页必须完整结束；游标循环、重复轮次和摘要视图均明确失败，不能当完整原文发布。 */
async function paginate(rpc, threadId) {
  const meta = await rpc('thread/read', { threadId, includeTurns: false });
  if (meta.thread?.id !== threadId || typeof meta.thread.cwd !== 'string') throw new Error('Codex 历史线程身份或目录缺失。');
  const turns = [], seen = new Set(), cursors = new Set();
  let cursor = null;
  for (let n = 0; n < 512; n++) {
    const page = await rpc('thread/turns/list', { threadId, limit: 50, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data) || !Object.hasOwn(page, 'nextCursor')) throw new Error('Codex 分页结果缺少完整性标识。');
    for (const turn of page.data) {
      if (typeof turn.id !== 'string' || seen.has(turn.id) || !Array.isArray(turn.items) || (turn.itemsView && turn.itemsView !== 'full')) throw new Error('Codex 轮次重复或正文未完整加载。');
      seen.add(turn.id); turns.push(turn);
    }
    cursor = page.nextCursor;
    if (cursor === null) return { thread: { id: meta.thread.id, cwd: meta.thread.cwd }, turns };
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || !page.data.length) throw new Error('Codex 历史分页游标异常。');
    cursors.add(cursor);
  }
  throw new Error('Codex 历史分页超过处理上限，未截断保存。');
}

/** 协议只传固定方法；未知服务端请求直接拒绝，错误不转储原始请求、密钥或聊天正文。 */
async function worker(threadId) {
  const child = CP.spawn(executable(), ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map(); let next = 0, buffer = '', bytes = 0;
  const fail = () => { for (const p of pending.values()) p.reject(new Error('Codex 只读历史接口不可用。')); pending.clear(); };
  child.on('error', fail); child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 64 * 1024 * 1024) { fail(); child.kill(); return; }
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail(); child.kill(); return; }
      if (message.method && message.id !== undefined) { child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only client' } }) + '\n'); continue; }
      const p = pending.get(message.id);
      if (!p) continue;
      pending.delete(message.id);
      if (message.error) p.reject(new Error('Codex 不支持完整只读历史或请求失败，请检查客户端版本。'));
      else p.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (!['initialize', 'thread/read', 'thread/turns/list'].includes(method)) return reject(new Error('禁止非只读历史操作。'));
    const id = ++next; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, 10000);
  try {
    await rpc('initialize', { clientInfo: { name: 'inner-dialogue-history', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return await paginate(rpc, threadId);
  } finally { clearTimeout(timer); child.stdin.end(); child.kill(); }
}

/** 限时同步读取，输出仅供归档解析；失败时保留旧快照，不回退到局部文件。 */
function read(threadId) {
  const result = CP.spawnSync(process.execPath, [__filename, '--worker', threadId], { encoding: 'utf8', timeout: 12000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Codex 完整历史读取失败；未使用局部记录归档，请检查本机客户端及只读历史接口。');
  return JSON.parse(result.stdout);
}

module.exports = { read, paginate };
if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== '--worker' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(process.argv[3])) process.exitCode = 1;
  else worker(process.argv[3]).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => { process.exitCode = 1; });
}
