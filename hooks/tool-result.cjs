// <!-- version: 1.0.0 -->
/**
 * Codex PostToolUse 结果归一化。仅解释明确状态字段及原生执行记录，
 * 不把 stdout 中的错误示例、搜索词或聊天正文当执行状态；缺少证据时返回 unknown。
 * 返回值只含白名单元数据，原始结果不进入运行日志。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');

/** 退出码允许客户端明确提供的整数或整数字符串；null、空串和布尔值不视为零。 */
function exitCode(value) {
  if (typeof value === 'string' && /^-?\d{1,10}$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && typeof value === 'number' ? value : undefined;
}

/** 结构化字段优先；MCP 的 isError 与原有 is_error 都是明确证据，非零退出码优先判失败。 */
function structured(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const codes = [exitCode(value.exit_code), exitCode(value.exitCode)].filter(code => code !== undefined);
  const code = codes.find(code => code !== 0) ?? codes[0];
  const duration = Number.isFinite(value.wall_time_seconds) && value.wall_time_seconds >= 0 ? Math.round(value.wall_time_seconds * 1000) : undefined;
  if (value.is_error === true || value.isError === true || (code !== undefined && code !== 0) || ['failed', 'failure', 'error'].includes(value.status)) return { status: 'failure', ...(code !== undefined ? { exit_code: code } : {}), ...(duration !== undefined ? { duration_ms: duration } : {}) };
  if (['running', 'in_progress'].includes(value.status) || (value.session_id !== undefined && value.session_id !== null && code === undefined)) return { status: 'running' };
  if (code === 0 || value.is_error === false || value.isError === false || ['success', 'succeeded'].includes(value.status)) return { status: 'success', ...(code !== undefined ? { exit_code: code } : {}), ...(duration !== undefined ? { duration_ms: duration } : {}) };
  return null;
}

/** 字符串和内容块可能就是文件正文，即使形似执行器头或 JSON，也不能作为退出状态证据。 */
function result(payload) {
  return structured(payload.tool_response) || { status: 'unknown' };
}

/**
 * 桌面版可能只传 stdout，退出状态需从已经由客户端身份校验的当前记录中读取。
 * 有界读取末尾 8 MiB，仅接受同线程、同轮次、同工具调用的完成条目；不取邻近调用猜测。
 * 文件尚未发布结果、记录过大或损坏时返回未知，不等待、不更改客户端记录和原操作。
 */
function recorded(payload) {
  const file = payload.transcript_path;
  if (!payload.tool_use_id || !payload.turn_id || !payload.native_session_id || typeof file !== 'string' || !PATH.isAbsolute(file)) return null;
  let fd;
  try {
    const stat = FS.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return null;
    fd = FS.openSync(file, 'r');
    const length = Math.min(stat.size, 8 * 1024 * 1024), buffer = Buffer.alloc(length), offset = stat.size - length;
    const count = FS.readSync(fd, buffer, 0, length, offset);
    const lines = buffer.subarray(0, count).toString('utf8').split('\n');
    if (offset) lines.shift();
    for (let n = lines.length - 1; n >= 0; n--) {
      let row;
      try { row = JSON.parse(lines[n]); } catch { continue; }
      const event = row.payload, item = event?.item;
      if (row.type !== 'event_msg' || event?.type !== 'item_completed' || event.thread_id !== payload.native_session_id || event.turn_id !== payload.turn_id || item?.id !== payload.tool_use_id) continue;
      if (item.type === 'CommandExecution') {
        const seconds = item.duration?.secs, nanos = item.duration?.nanos;
        return structured({ exit_code: item.exit_code, status: item.status, ...(Number.isFinite(seconds) && Number.isFinite(nanos) ? { wall_time_seconds: seconds + nanos / 1e9 } : {}) });
      }
      if (item.type === 'FileChange') return structured({ status: item.status === 'completed' ? 'success' : item.status });
      return null;
    }
  } catch { return null; }
  finally { if (fd !== undefined) FS.closeSync(fd); }
  return null;
}

/** 非零退出码或明确失败优先；结构化元数据与原生记录互为补充，不输出任一原始正文。 */
function resolve(payload) {
  const presented = result(payload), native = recorded(payload);
  if (native?.status === 'failure') return native;
  const explicit = structured(payload.tool_response);
  if (explicit?.status === 'failure') return explicit;
  // 原生完成状态补充钩子中未携带的退出码和耗时；stdout 不参与此判断。
  if (native?.status === 'success') return native;
  if (presented.status === 'failure') return presented;
  return presented.status !== 'unknown' ? presented : native || presented;
}
module.exports = { result, resolve };
