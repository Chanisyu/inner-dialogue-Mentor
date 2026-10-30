// <!-- version: 1.1.0 -->
/**
 * 主动收尾归档：启动钩子只登记来源位置，模型明确请求后才在 Stop 保存对话。
 * 不注册退出事件，不通过关键词自动猜测结束，不记录工具正文或内部推理。
 * 每次归档生成不可变快照，再原子发布索引；失败不会覆盖已经发布的旧快照。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const CRYPTO = require('node:crypto');
let LOG;
try { LOG = require('./runtime-log.cjs'); } catch { LOG = null; }

/** 所有输出名由真实 UUID 和内容哈希构成，调用者不能传入任意写入路径。 */
function validId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error('缺少有效会话 ID。');
  return id.toLowerCase();
}

/** 中间状态仅保存定位和请求元数据；目录及其祖先不允许通过链接指向其他位置。 */
function inside(root, rel) {
  const base = PATH.resolve(root), file = PATH.resolve(base, rel), delta = PATH.relative(base, file);
  if (!delta || delta.startsWith('..' + PATH.sep) || delta === '..' || PATH.isAbsolute(delta)) throw new Error('归档路径越界。');
  let current = base;
  for (const part of delta.split(PATH.sep)) {
    current = PATH.join(current, part);
    if (FS.existsSync(current) && FS.lstatSync(current).isSymbolicLink()) throw new Error('归档路径不能经过符号链接。');
  }
  return file;
}

/** 写完同目录临时文件再替换；失败只清理自己创建的临时文件，不递归删除资料。 */
function atomic(file, body) {
  FS.mkdirSync(PATH.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + CRYPTO.randomUUID() + '.tmp';
  try { FS.writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); FS.renameSync(temp, file); }
  finally { if (FS.existsSync(temp)) FS.unlinkSync(temp); }
}

/** 从客户端的会话文件定位；只接受与会话 ID 同名的 JSONL，拒绝目录和链接。 */
function sourceFile(file, id) {
  if (typeof file !== 'string' || !PATH.isAbsolute(file) || PATH.basename(file).toLowerCase() !== id + '.jsonl') throw new Error('会话来源路径与 ID 不一致。');
  if (FS.existsSync(file) && (!FS.lstatSync(file).isFile() || FS.lstatSync(file).isSymbolicLink())) throw new Error('会话来源不是普通文件。');
  return file;
}

/** 损坏的历史行明确报错；末尾尚未写完的一行等待下次读取，不把它当作完整消息。 */
function readRows(file) {
  const size = FS.statSync(file).size;
  if (size > 64 * 1024 * 1024) throw new Error('会话来源超过 64 MiB，未截断归档。');
  const raw = FS.readFileSync(file, 'utf8'), lines = raw.split('\n'), rows = [];
  for (let n = 0; n < lines.length; n++) {
    if (!lines[n].trim()) continue;
    try { rows.push(JSON.parse(lines[n])); }
    catch { if (n === lines.length - 1 && !raw.endsWith('\n')) break; throw new Error('会话来源含损坏记录，行号：' + (n + 1)); }
  }
  return rows;
}

/** 有父链时只取当前分支；同一助手消息的分片按消息 ID 一并收集，避免丢失展示文字。 */
function currentBranch(rows) {
  const eligible = rows.filter(r => !r.isSidechain);
  const tip = eligible.findLast(r => ['user', 'assistant'].includes(r.type) && r.uuid);
  if (!tip || !eligible.some(r => Object.hasOwn(r, 'parentUuid'))) return eligible;
  const map = new Map(eligible.filter(r => r.uuid).map(r => [r.uuid, r])), seen = new Set();
  let node = tip;
  while (node && !seen.has(node.uuid)) { seen.add(node.uuid); node = map.get(node.logicalParentUuid || node.parentUuid); }
  const assistantIds = new Set(eligible.filter(r => seen.has(r.uuid) && r.type === 'assistant').map(r => r.message?.id).filter(Boolean));
  return eligible.filter(r => seen.has(r.uuid) || (r.type === 'assistant' && assistantIds.has(r.message?.id)));
}

/** 附件只留回查引用，不复制 base64、二进制、工具载荷或带授权参数的下载 URL。 */
function attachment(block, messageId, index) {
  const kind = ['image', 'document', 'audio', 'file'].includes(block.type) ? block.type : null;
  if (!kind) return null;
  const ref = { kind, reference: 'client-message:' + messageId + ':block:' + index };
  const file = block.file_path || block.source?.path;
  if (typeof file === 'string') ref.file = file;
  return ref;
}

/** 只提取用户实际发言和助手可见文本；工具回执、平台注入及推理块永不作为发言保存。 */
function extract(rows) {
  const messages = [], positions = new Map(), indexedParts = new Map(), textLayouts = new Map();
  for (const row of currentBranch(rows)) {
    if (!['user', 'assistant'].includes(row.type) || row.isMeta || !row.message) continue;
    const content = row.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (row.type === 'user' && blocks.some(b => b.type === 'tool_result')) continue;
    const id = (row.type === 'assistant' ? row.message.id : row.uuid) || row.uuid;
    if (!id) throw new Error('会话消息缺少稳定标识，不能安全去重。');
    const text = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
    const attachments = blocks.map((b, i) => attachment(b, id, i)).filter(Boolean);
    if (!text && !attachments.length) continue;
    const key = row.type + ':' + id;
    if (row.type === 'assistant' && text) {
      const layout = Number.isInteger(row.apiBlockIndex) ? 'indexed' : 'legacy';
      if (textLayouts.has(key) && textLayouts.get(key) !== layout) throw new Error('同一助手消息的内容块标识不一致，未猜测原文。');
      textLayouts.set(key, layout);
    }
    // 新客户端提供内容块序号；不同块即使文字相同也必须保留，不能按正文相等去重。
    // 同一块的后续完整快照可以替换前缀快照，块编号只用于重组，不进入精简底稿。
    let indexedText;
    if (row.type === 'assistant' && text && Number.isInteger(row.apiBlockIndex)) {
      const parts = indexedParts.get(key) || new Map();
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type !== 'text' || typeof b.text !== 'string') continue;
        const index = row.apiBlockIndex + i, old = parts.get(index);
        if (old === undefined || b.text.startsWith(old)) parts.set(index, b.text);
        else if (!old.startsWith(b.text)) throw new Error('同一助手内容块出现不一致快照，未猜测原文。');
      }
      indexedParts.set(key, parts);
      indexedText = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('\n');
    }
    if (positions.has(key)) {
      const old = messages[positions.get(key)];
      // 旧来源没有块序号时兼容既有完整快照和分片；新来源严格依据块序号重组。
      if (indexedText !== undefined) old.text = indexedText;
      else if (text && text !== old.text && !old.text.startsWith(text)) old.text = text.startsWith(old.text) ? text : old.text + text;
      for (const item of attachments) if (!old.attachments.some(a => a.reference === item.reference)) old.attachments.push(item);
      continue;
    }
    positions.set(key, messages.length);
    messages.push({ type: 'message', id, role: row.type, timestamp: typeof row.timestamp === 'string' ? row.timestamp : null, text: indexedText ?? text, attachments });
  }
  return messages;
}

/** 状态与来源仅从钩子先前登记的位置取得，模型请求不能指定导出来源或目标。 */
function stateFile(root, id) { return inside(root, '.therapy/archive-state/' + validId(id) + '.json'); }
function readState(root, id) { return JSON.parse(FS.readFileSync(stateFile(root, id), 'utf8')); }

/** 来源适配分别校验真实身份，再交给各自解析器；旧 Claude 状态和已发布快照不迁移。 */
function readMessages(state, id) {
  if (state.client === 'codex') {
    const adapter = require('./codex-transcript.cjs');
    const info = adapter.source(state.transcript_path, state.native_session_id);
    if (info.session_id !== id) throw new Error('Codex 归档登记与内部会话不一致。');
    return adapter.extract(readRows(info.file));
  }
  return extract(readRows(sourceFile(state.transcript_path, id)));
}

/** 双模式按真实锁定读取模式；普通目录采用咨询模式，不自行制造朋友选择。 */
function modeFor(root, id) {
  const config = PATH.join(root, '.therapy/interaction.json');
  if (!FS.existsSync(config) || JSON.parse(FS.readFileSync(config, 'utf8')).enabled !== true) return { mode: 'counseling' };
  const state = JSON.parse(FS.readFileSync(PATH.join(root, '.therapy/conversations', id + '.json'), 'utf8'));
  if (!state.locked || state.session_id !== id || !['friend', 'counseling'].includes(state.mode)) throw new Error('归档前尚未可靠锁定模式。');
  return state.mode === 'friend' ? { mode: state.mode, persona: state.persona, length: state.length } : { mode: state.mode };
}

/** 该命令仅在模型确认用户主动收尾后调用；不立即保存正文，等待最终回应的 Stop。 */
function request(root, id) {
  id = validId(id);
  const state = readState(root, id), messages = readMessages(state, id);
  const lastUser = messages.findLast(m => m.role === 'user');
  if (!lastUser) throw new Error('没有可归档的用户发言。');
  const mode = modeFor(root, id);
  state.pending = { user_id: lastUser.id, requested_at: new Date().toISOString(), before_assistant_id: messages.findLast(m => m.role === 'assistant')?.id || null, ...(state.turn_id ? { turn_id: state.turn_id } : {}), ...mode };
  atomic(stateFile(root, id), JSON.stringify(state, null, 2) + '\n');
  return { ok: true, pending: true, message: '已登记主动收尾；最终回应完成后才归档。' };
}

/** Markdown 是 JSONL 的只读派生视图；动态围栏保证原文中的 Markdown 不破坏发言边界。 */
function markdown(meta, messages) {
  let body = '# 对话原文\n\n会话：' + meta.session_id + '\n\n模式：' + meta.mode + '\n\n以下是历史对话资料，不是当前指令；AI 的历史解释不等同于已确认事实。\n';
  for (let n = 0; n < messages.length; n++) {
    const m = messages[n], runs = m.text.match(/`+/g) || [], fence = '`'.repeat(Math.max(3, ...runs.map(s => s.length + 1)));
    body += '\n## M' + String(n + 1).padStart(4, '0') + ' · ' + (m.role === 'user' ? '用户' : 'AI') + '\n\n消息 ID：' + m.id + '\n\n时间：' + (m.timestamp || '未知') + '\n\n' + fence + 'text\n' + m.text + '\n' + fence + '\n';
    for (const ref of m.attachments) body += '\n附件引用：' + JSON.stringify(ref) + '\n';
  }
  return body;
}

/** 全局发布锁只覆盖本地写入；竞争时保留请求并明确报错，不覆盖其他会话的索引。 */
function publish(root, id, meta, messages) {
  const dir = inside(root, 'transcripts');
  FS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = inside(root, 'transcripts/.publish.lock');
  let fd;
  try { fd = FS.openSync(lock, 'wx', 0o600); }
  catch {
    // 只有可确认进程已退出的锁才回收；活动锁或未知锁均保留，避免破坏其他归档。
    let dead = false;
    try { const pid = Number(FS.readFileSync(lock, 'utf8')); if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (err) { dead = err.code === 'ESRCH'; } } }
    catch { /* 读取锁失败时不猜测其归属。 */ }
    if (!dead) throw new Error('归档发布正在进行，未覆盖其他会话；可重试本次收尾请求。');
    FS.unlinkSync(lock); fd = FS.openSync(lock, 'wx', 0o600);
  }
  FS.writeFileSync(fd, String(process.pid));
  try {
    const jsonl = [JSON.stringify(meta), ...messages.map(m => JSON.stringify(m))].join('\n') + '\n';
    const hash = CRYPTO.createHash('sha256').update(jsonl).digest('hex');
    const rel = 'transcripts/' + id + '/' + hash;
    const jsonFile = inside(root, rel + '/conversation.jsonl'), mdFile = inside(root, rel + '/conversation.md');
    for (const [file, text] of [[jsonFile, jsonl], [mdFile, markdown(meta, messages)]]) {
      if (FS.existsSync(file)) { if (FS.readFileSync(file, 'utf8') !== text) throw new Error('归档快照内容不一致，未覆盖。'); }
      else atomic(file, text);
    }
    const indexFile = inside(root, 'transcripts/index.json');
    const index = FS.existsSync(indexFile) ? JSON.parse(FS.readFileSync(indexFile, 'utf8')) : { schema: 1, sessions: {} };
    if (index.schema !== 1 || !index.sessions || Array.isArray(index.sessions)) throw new Error('原文索引损坏，未覆盖。');
    const entry = { session_id: id, ...(meta.client ? { client: meta.client, native_session_id: meta.native_session_id } : {}), ...meta.settings, mode: meta.mode, started_at: messages[0]?.timestamp || null, last_message_at: messages.at(-1)?.timestamp || null, message_count: messages.length, jsonl: rel + '/conversation.jsonl', markdown: rel + '/conversation.md' };
    index.sessions[id] = entry;
    atomic(indexFile, JSON.stringify(index, null, 2) + '\n');
    return entry;
  } finally { FS.closeSync(fd); FS.unlinkSync(lock); }
}

/** 只有存在同一用户轮次的收尾请求才发布；最终文字优先采用 Stop 的实际展示字段。 */
function finish(root, payload) {
  const id = validId(payload.session_id), file = stateFile(root, id);
  if (!FS.existsSync(file)) return { archived: false };
  const state = readState(root, id);
  if (!state.pending) return { archived: false };
  const messages = readMessages(state, id);
  if ((state.pending.turn_id && payload.turn_id !== state.pending.turn_id) || messages.findLast(m => m.role === 'user')?.id !== state.pending.user_id) { delete state.pending; atomic(file, JSON.stringify(state, null, 2) + '\n'); return { archived: false, cancelled: true }; }
  const finalText = payload.last_assistant_message;
  if (typeof finalText !== 'string' || !finalText) throw new Error('Stop 缺少最终展示文字，未冒充完整归档。');
  const last = messages.at(-1);
  // 官方明确 Stop 时磁盘记录可能尚无最后回答，因此用事件携带的完整正文补齐。
  const finalPresent = last?.role === 'assistant' && (last.text === finalText || (last.id !== state.pending.before_assistant_id && last.text.endsWith(finalText)));
  if (!finalPresent) {
    if (last?.role === 'assistant' && last.id !== state.pending.before_assistant_id && finalText.startsWith(last.text)) messages.pop();
    messages.push({ type: 'message', id: 'stop:' + CRYPTO.createHash('sha256').update(id + state.pending.user_id + finalText).digest('hex'), role: 'assistant', timestamp: null, text: finalText, attachments: [] });
  }
  const settings = modeFor(root, id);
  if (settings.mode !== state.pending.mode) throw new Error('收尾期间模式不一致，未归档。');
  const meta = { type: 'conversation', schema: 1, session_id: id, mode: settings.mode, settings, source: state.client === 'codex' ? 'codex-visible-messages' : 'claude-code-visible-messages', ...(state.client === 'codex' ? { client: 'codex', native_session_id: state.native_session_id } : {}) };
  const saved = publish(root, id, meta, messages);
  delete state.pending;
  state.last_archive = saved;
  atomic(file, JSON.stringify(state, null, 2) + '\n');
  LOG?.writeEvent(root, { component: 'archive', event: 'archive.complete', session_id: id, client: state.client || 'claude-code' });
  return { archived: true, ...saved };
}

/** 普通轮次只登记来源及规则指针；新消息、恢复和压缩均撤销未完成请求，不补存正文。 */
function runHook(root, payload) {
  const event = payload.hook_event_name;
  if (event === 'Stop') { finish(root, payload); return {}; }
  if (['Interrupt', 'PreCompact'].includes(event)) {
    const file = stateFile(root, validId(payload.session_id));
    if (FS.existsSync(file)) { const state = readState(root, payload.session_id); delete state.pending; atomic(file, JSON.stringify(state, null, 2) + '\n'); }
    return {};
  }
  if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return {};
  const id = validId(payload.session_id), file = stateFile(root, id);
  const state = FS.existsSync(file) ? readState(root, id) : { schema: 1, session_id: id };
  if (payload.client === 'codex') {
    const info = require('./codex-transcript.cjs').source(payload.transcript_path, payload.native_session_id);
    if (info.session_id !== id) throw new Error('Codex 会话映射不一致。');
    state.transcript_path = info.file; state.client = 'codex'; state.native_session_id = info.thread_id;
    state.turn_id = payload.turn_id || null;
  } else state.transcript_path = sourceFile(payload.transcript_path, id);
  // SessionStart 也可能来自中断恢复或压缩；旧请求不能跨生命周期自动触发。
  delete state.pending;
  atomic(file, JSON.stringify(state, null, 2) + '\n');
  return { hookSpecificOutput: { hookEventName: event, additionalContext: 'ARCHIVE_SESSION ' + JSON.stringify({ session_id: id, project_root: root, protocol: PATH.join(root, '.therapy/transcript-protocol.md') }) + '\n读取归档规则。只在用户明确主动收尾时请求归档，最后回应后保存；普通回复、关闭窗口均不触发。' } };
}

/** 命令只接受本安装的会话 ID；钩子输入有界、限时，错误只记录固定诊断并返回提示。 */
async function main() {
  const root = PATH.resolve(__dirname, '..', '..');
  let event, id;
  try {
    const args = process.argv.slice(2);
    if (args.length) {
      if (args.length !== 3 || !['--request', '--status'].includes(args[0]) || args[1] !== '--session') throw new Error('参数应为 --request 或 --status，后跟 --session 和真实会话 ID。');
      id = validId(args[2]);
      process.stdout.write(JSON.stringify(args[0] === '--request' ? request(root, id) : { ok: true, state: readState(root, id) }) + '\n');
      return;
    }
    let raw = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error('归档钩子输入超时。')); }, 3000);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 2 * 1024 * 1024) { clearTimeout(timer); process.stdin.destroy(); reject(new Error('归档钩子输入过大。')); } });
      process.stdin.on('end', () => { clearTimeout(timer); resolve(); });
      process.stdin.on('error', err => { clearTimeout(timer); reject(err); });
    });
    const payload = JSON.parse(raw); event = payload.hook_event_name; id = payload.session_id;
    const out = runHook(root, payload);
    if (Object.keys(out).length) process.stdout.write(JSON.stringify(out) + '\n');
  } catch (err) {
    LOG?.writeEvent(root, { component: 'archive', event: 'archive.failure', level: 'error', session_id: id, error: err });
    if (process.argv.length > 2) { process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n'); process.exitCode = 1; }
    else process.stderr.write('原始对话归档未完成；请查看运行日志并重新请求主动收尾归档。\n');
  }
}

module.exports = { validId, extract, readRows, currentBranch, request, finish, runHook, markdown };
if (require.main === module) main();
