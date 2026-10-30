// <!-- version: 1.0.0 -->
/**
 * 统一本地运行日志及只观察、不拦截操作的 Claude Code 钩子。
 * 仅保存白名单元数据；聊天、工具正文、命令、搜索词和原始异常文本均不落盘。
 * 每条记录单次追加；轮转使用独占锁，最多保留当前文件及三个历史文件。
 * 日志失败返回状态，不向模型注入内容，也不改变原操作的成功或失败。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const OS = require('node:os');

const EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd']);
const MAX_BYTES = 2 * 1024 * 1024;
const BACKUPS = 3;
const ERROR_MESSAGES = Object.freeze({
  ENOENT: '目标文件或目录不存在', EACCES: '没有访问权限', EPERM: '操作被系统拒绝',
  ENOSPC: '存储空间不足', EIO: '文件读写失败', ETIMEDOUT: '操作超时',
  ECONNRESET: '连接中断', ECONNREFUSED: '连接被拒绝', EEXIST: '目标已经存在',
  INVALID_JSON: '输入或配置不是有效 JSON', INVALID_INPUT: '钩子输入无效',
  INPUT_TOO_LARGE: '钩子输入超过大小限制', POLICY_DENIED: '操作被模式规则拦截',
  MODE_ERROR: '模式配置或会话状态检查失败', TOOL_ERROR: '工具执行失败，原始信息见客户端记录',
  ERROR: '操作失败，原始信息见客户端记录',
});

/** 将异常归类为固定原因；即使异常含聊天、密钥或文件正文，也不复制其原始文字。 */
function errorInfo(error) {
  const candidate = error && typeof error === 'object' ? error.code : null;
  let code = Object.hasOwn(ERROR_MESSAGES, candidate) ? candidate : null;
  if (!code) {
    const text = String(error?.message || error || '').slice(0, 8192);
    if (/ENOENT|file does not exist|no such file|文件不存在/i.test(text)) code = 'ENOENT';
    else if (/EACCES|permission denied|access denied/i.test(text)) code = 'EACCES';
    else if (/timed?\s*out|timeout|超时/i.test(text)) code = 'ETIMEDOUT';
    else if (error instanceof SyntaxError || /(?:invalid|valid|malformed).*json|json.*(?:syntax|parse|unexpected)/i.test(text)) code = 'INVALID_JSON';
    else code = 'ERROR';
  }
  return { code, message: ERROR_MESSAGES[code] };
}

/** 只保留项目内的相对文件位置；不写外部个人路径，也不把命令或搜索词当文件名。 */
function safeFile(root, file) {
  if (typeof file !== 'string' || !file || /[\r\n\0]|(?:token|password|secret|key)[=:]/i.test(file)) return undefined;
  const rel = PATH.relative(PATH.resolve(root), PATH.resolve(root, file));
  if (rel === '..' || rel.startsWith('..' + PATH.sep) || PATH.isAbsolute(rel)) return '[outside-project]';
  return (rel || '.').replaceAll('\\', '/').slice(0, 300);
}

/** 未完成安装的 CLI 错误可使用用户目录兜底；普通钩子不自行创建咨询安装目录。 */
function logPath(root, fallback = false) {
  if (typeof root === 'string' && FS.existsSync(PATH.join(root, '.therapy'))) return PATH.join(PATH.resolve(root), '.therapy', 'logs', 'runtime.jsonl');
  return fallback ? PATH.join(OS.homedir(), '.inner-dialogue', 'logs', 'runtime.jsonl') : null;
}

/** 只轮转本日志的确定文件名；其他并行写入者不等待锁，仍可直接追加日志。 */
function rotate(file, maxBytes) {
  if (!FS.existsSync(file) || FS.statSync(file).size < maxBytes) return;
  const lock = file + '.lock';
  let fd;
  try {
    try { fd = FS.openSync(lock, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // 崩溃留下的锁只有在所属进程确已结束后才回收，避免误删活动进程的锁。
      try {
        const pid = Number(FS.readFileSync(lock, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) return;
        try { process.kill(pid, 0); return; } catch (probe) { if (probe.code !== 'ESRCH') return; }
        FS.unlinkSync(lock);
        fd = FS.openSync(lock, 'wx', 0o600);
      } catch { return; }
    }
    FS.writeFileSync(fd, String(process.pid));
    if (!FS.existsSync(file) || FS.statSync(file).size < maxBytes) return;
    const oldest = file + '.' + BACKUPS;
    if (FS.existsSync(oldest)) FS.unlinkSync(oldest);
    for (let n = BACKUPS - 1; n >= 1; n--) if (FS.existsSync(file + '.' + n)) FS.renameSync(file + '.' + n, file + '.' + (n + 1));
    FS.renameSync(file, file + '.1');
  } finally {
    if (fd !== undefined) { FS.closeSync(fd); FS.unlinkSync(lock); }
  }
}

/** 白名单构造记录后一次追加；未知字段、原始异常和请求正文不会进入输出。 */
function writeEvent(root, entry, options = {}) {
  try {
    const file = logPath(root, options.fallback === true);
    if (!file) return { ok: false, code: 'NO_INSTALL_ROOT' };
    const token = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(value) ? value : undefined;
    const row = {
      schema: 1, timestamp: new Date().toISOString(), pid: process.pid,
      level: ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
      component: token(entry.component) || 'runtime', event: token(entry.event) || 'unknown',
    };
    if (typeof entry.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(entry.session_id)) row.session_id = entry.session_id;
    if (token(entry.hook_event)) row.hook_event = entry.hook_event;
    if (token(entry.tool_name)) row.tool_name = entry.tool_name;
    if (typeof entry.tool_use_id === 'string' && /^toolu_[a-zA-Z0-9_-]{1,100}$/.test(entry.tool_use_id)) row.tool_use_id = entry.tool_use_id;
    if (['install', 'update', 'doctor', 'dual-mode'].includes(entry.command)) row.command = entry.command;
    if (['friend', 'counseling'].includes(entry.mode)) row.mode = entry.mode;
    const relative = safeFile(root || process.cwd(), entry.file);
    if (relative !== undefined) row.file = relative;
    if (Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0) row.duration_ms = Math.round(entry.duration_ms);
    if (Number.isInteger(entry.exit_code)) row.exit_code = entry.exit_code;
    if (entry.error !== undefined) row.error = errorInfo(entry.error);
    FS.mkdirSync(PATH.dirname(file), { recursive: true, mode: 0o700 });
    rotate(file, options.maxBytes || MAX_BYTES);
    FS.appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
    return { ok: true, file };
  } catch (err) {
    return { ok: false, code: errorInfo(err).code };
  }
}

/** 从已安装脚本位置优先定位根目录，工作目录改变不会把日志写入错误的子目录。 */
function resolveRoot(payload = {}) {
  if (PATH.basename(__dirname) === 'hooks' && PATH.basename(PATH.dirname(__dirname)) === '.therapy') return PATH.resolve(__dirname, '..', '..');
  return PATH.resolve(process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
}

/** 观察事件只记录结果元数据；PostToolUseFailure 的原始错误仅用于归类，不写正文。 */
function observe(payload, root = resolveRoot(payload)) {
  if (!payload || typeof payload !== 'object' || !EVENTS.includes(payload.hook_event_name)) return writeEvent(root, { component: 'observer', event: 'input.invalid', level: 'error', error: { code: 'INVALID_INPUT' } });
  const event = payload.hook_event_name;
  const names = { SessionStart: 'session.start', UserPromptSubmit: 'prompt.submitted', PreToolUse: 'tool.start', PostToolUse: 'tool.success', PostToolUseFailure: 'tool.failure', SessionEnd: 'session.end' };
  return writeEvent(root, {
    component: 'observer', event: names[event], level: event === 'PostToolUseFailure' ? 'error' : 'info',
    session_id: payload.session_id, hook_event: event, tool_name: payload.tool_name, tool_use_id: payload.tool_use_id,
    file: payload.tool_input?.file_path || payload.tool_input?.path, duration_ms: payload.duration_ms,
    ...(event === 'PostToolUseFailure' ? { error: payload.error || { code: 'TOOL_ERROR' } } : {}),
  });
}

/** 钩子 stdin 有界且限时；任何故障都不输出决策、不注入模型上下文。 */
async function main() {
  let raw = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { process.stdin.destroy(); reject(Object.assign(new Error(), { code: 'ETIMEDOUT' })); }, 2000);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 1024 * 1024) { clearTimeout(timer); process.stdin.destroy(); reject(Object.assign(new Error(), { code: 'INPUT_TOO_LARGE' })); } });
      process.stdin.on('end', () => { clearTimeout(timer); resolve(); });
      process.stdin.on('error', err => { clearTimeout(timer); reject(err); });
    });
    observe(JSON.parse(raw));
  } catch (err) { writeEvent(resolveRoot(), { component: 'observer', event: 'input.failure', level: 'error', error: err }); }
}

module.exports = { EVENTS, MAX_BYTES, BACKUPS, writeEvent, observe, errorInfo, logPath };
if (require.main === module) main();
