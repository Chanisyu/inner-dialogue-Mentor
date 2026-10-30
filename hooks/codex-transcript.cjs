// <!-- version: 1.0.0 -->
/**
 * Codex 来源适配器：只读取客户端已经保存的可见发言，绝不导出推理或工具载荷。
 * 优先使用完成事件中的用户和助手条目，避免把模型请求中的注入、压缩回放当原话。
 * 当前格式与旧版事件格式分别识别；未知格式明确失败，不用模型补写历史。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const S = require('./local-storage.cjs');

/** 原生标识只用于校验和来源说明；内部 UUID 由客户端命名空间确定，恢复后稳定。 */
function nativeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value)) throw new Error('Codex 没有提供有效的原生对话标识。');
  return value;
}
function conversationId(id) {
  const hex = S.hash('inner-dialogue:codex:' + nativeId(id));
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-5' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

/** Codex 文件名带时间前缀，必须核对内容中的身份，不能套用 Claude 的同名文件规则。 */
function source(file, native) {
  nativeId(native);
  if (typeof file !== 'string' || !PATH.isAbsolute(file) || PATH.extname(file).toLowerCase() !== '.jsonl') throw new Error('Codex 原始记录位置不可用。');
  const stat = FS.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('Codex 原始记录不是受支持的普通文件或超过 64 MiB。');
  const fd = FS.openSync(file, 'r'), buffer = Buffer.alloc(512 * 1024);
  let header;
  try {
    const count = FS.readSync(fd, buffer, 0, buffer.length, 0), raw = buffer.subarray(0, count).toString('utf8');
    header = JSON.parse(raw.split('\n')[0]);
  } finally { FS.closeSync(fd); }
  if (header.type !== 'session_meta' || !header.payload?.id) throw new Error('无法识别 Codex 会话头，未猜测来源身份。');
  const id = nativeId(header.payload.id);
  if (native !== id && native !== header.payload.session_id) throw new Error('Codex 来源与当前会话不一致。');
  return { file, thread_id: id, session_id: conversationId(id), cwd: header.payload.cwd, parent_thread_id: header.payload.forked_from_id || header.payload.parent_thread_id || null };
}

/** 已完成条目的正文块有两种大小写形式；附件只留下原始条目回查引用。 */
function body(item, id) {
  const content = Array.isArray(item.content) ? item.content : [];
  const text = [], attachments = [];
  for (let n = 0; n < content.length; n++) {
    const block = content[n], kind = String(block.type || '').toLowerCase();
    if (kind === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (['image', 'localimage', 'audio', 'file', 'document', 'attachment'].includes(kind)) {
      const ref = { kind: kind === 'localimage' ? 'image' : kind, reference: 'codex-item:' + id + ':block:' + n };
      if (typeof block.path === 'string') ref.file = block.path;
      attachments.push(ref);
    } else if (!['mention', 'skill'].includes(kind)) throw new Error('Codex 可见条目含未知内容块，未截断保存。');
  }
  return { text: text.join('\n'), attachments };
}

/** 当前事件格式以稳定条目 ID 去重；回滚只移除撤回的用户轮次，不读取压缩替代正文。 */
function extract(rows) {
  if (rows[0]?.type !== 'session_meta') throw new Error('Codex 原始记录缺少会话头。');
  const current = rows.some(r => r.type === 'event_msg' && r.payload?.type === 'item_completed');
  const messages = [], positions = new Map();
  let turn = null;
  const add = (row, item, role) => {
    if (typeof item.id !== 'string' || !item.id) throw new Error('Codex 可见发言缺少条目标识。');
    const data = body(item, item.id);
    if (!data.text && !data.attachments.length) return;
    const value = { type: 'message', id: item.id, role, timestamp: typeof row.timestamp === 'string' ? row.timestamp : null, ...data };
    const key = role + ':' + item.id;
    if (positions.has(key)) {
      const old = messages[positions.get(key)];
      if (old.text !== value.text || JSON.stringify(old.attachments) !== JSON.stringify(value.attachments)) throw new Error('Codex 同一完成条目出现不一致正文。');
      return;
    }
    positions.set(key, messages.length); messages.push({ ...value, _turn: row.payload?.turn_id || turn });
  };
  for (let n = 0; n < rows.length; n++) {
    const row = rows[n], p = row.payload || {};
    if (row.type !== 'event_msg') continue;
    if (p.type === 'task_started' || p.type === 'turn_started') turn = p.turn_id || null;
    if (p.type === 'thread_rolled_back') {
      if (!Number.isInteger(p.num_turns) || p.num_turns < 0) throw new Error('Codex 回滚信息无效。');
      for (let k = 0; k < p.num_turns; k++) {
        const start = messages.findLastIndex(m => m.role === 'user');
        if (start < 0) throw new Error('Codex 回滚范围超出可恢复历史。');
        messages.splice(start);
      }
      positions.clear(); messages.forEach((m, i) => positions.set(m.role + ':' + m.id, i));
    }
    if (current) {
      if (p.type !== 'item_completed') continue;
      const item = p.item || {};
      if (item.type === 'UserMessage') add(row, item, 'user');
      else if (item.type === 'AgentMessage' && (!item.phase || ['commentary', 'final_answer'].includes(item.phase))) add(row, item, 'assistant');
    } else {
      // 旧版事件正文比 response_item 更接近实际显示内容，避免混入开发者注入及回放。
      if (!['user_message', 'agent_message'].includes(p.type)) continue;
      const text = p.message;
      if (typeof text !== 'string') throw new Error('旧版 Codex 发言格式不可识别。');
      const id = p.id || 'event:' + S.hash(String(row.ordinal ?? n) + ':' + (row.timestamp || '') + ':' + text);
      const content = [{ type: 'text', text }];
      for (const image of p.images || []) content.push({ type: 'image', path: typeof image === 'string' && !/^(?:data:|https?:)/i.test(image) ? image : undefined });
      add(row, { id, content }, p.type === 'user_message' ? 'user' : 'assistant');
    }
  }
  if (!messages.some(m => m.role === 'user')) throw new Error('Codex 没有可识别的真实用户发言，未导出模型请求副本。');
  return messages.map(({ _turn, ...message }) => message);
}

/** 先用真实来源头取得恢复后不变的线程 ID，再映射为项目内部会话；不复用其他客户端状态。 */
function normalize(payload, root) {
  const native = nativeId(payload.session_id), info = source(payload.transcript_path, native);
  if (root && info.cwd) {
    const key = value => process.platform === 'win32' ? PATH.resolve(value).toLowerCase() : PATH.resolve(value);
    if (key(info.cwd) !== key(root)) throw new Error('Codex 原始对话不属于当前咨询师主目录。');
  }
  return { ...payload, session_id: info.session_id, client: 'codex', native_session_id: info.thread_id };
}
module.exports = { nativeId, conversationId, source, extract, normalize };
