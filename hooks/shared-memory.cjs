// <!-- version: 1.0.0 -->
/**
 * 共享资料保存入口：两个客户端先取得同一版本，再提交完整候选文件，冲突时要求重读。
 * 全局写锁串行发布；写前保存私有回滚资料，版本号最后发布，中断可恢复。
 * 运行日志只含结果元数据；候选正文与恢复资料仅在咨询目录的私有状态区保存。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const CRYPTO = require('node:crypto');
const S = require('./local-storage.cjs');
let LOG;
try { LOG = require('./runtime-log.cjs'); } catch { LOG = null; }
const SHARED = ['context', 'sessions', 'friend-sessions', 'friend-hypotheses'];
const REVISION = '.therapy/shared-state.json';
const LOCK = '.therapy/memory-write.lock';

/** 所有内部状态只按已校验的会话标识定位，不能让模型任意指定恢复或写入位置。 */
function statePath(root, id) { return S.inside(root, '.therapy/memory-state/' + S.uuid(id) + '.json'); }
function state(root, id) {
  const value = S.read(statePath(root, id));
  if (value.schema !== 1 || value.session_id !== id) throw new Error('共享资料会话登记损坏。');
  return value;
}
function revision(root) {
  const file = S.inside(root, REVISION), value = FS.existsSync(file) ? S.read(file) : { schema: 1, revision: 0, commit_id: null };
  if (value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('共享资料版本登记损坏。');
  return value;
}

/** 记录客户端来源但不让来源改变业务模式；双模式仍以已锁定的会话状态为准。 */
function mode(root, id) {
  const file = S.inside(root, '.therapy/interaction.json');
  if (!FS.existsSync(file) || S.read(file).enabled !== true) return 'counseling';
  const selected = S.read(S.inside(root, '.therapy/conversations/' + S.uuid(id) + '.json'));
  if (selected.session_id !== id || selected.locked !== true || !['friend', 'counseling'].includes(selected.mode)) throw new Error('请先完成本条对话的模式锁定。');
  return selected.mode;
}

/** 只接受档案、既定主题和本会话摘要；旧会话摘要不作为本次保存的覆盖目标。 */
function allowed(rel, id, selected) {
  if (typeof rel !== 'string' || rel.includes('\\') || /[\0\r\n:]/.test(rel) || rel.split('/').some(p => !p || p === '.' || p === '..')) return false;
  if (rel === 'profile.md' || rel === 'context/index.md') return true;
  if (/^context\/(people|places|concepts|events)\/[^/]+\.md$/.test(rel)) return true;
  const dirs = selected === 'friend' ? ['friend-sessions', 'friend-hypotheses'] : ['sessions'];
  return dirs.some(dir => new RegExp('^' + dir + '/\\d{4}-\\d{2}-\\d{2}-' + S.uuid(id) + '\\.md$').test(rel));
}

/** 对共享资料计算哈希，既能识别另一客户端提交，也能识别用户在外部手动修改。 */
function inventory(root) {
  const files = {};
  const add = rel => {
    const file = S.inside(root, rel), stat = FS.statSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('共享资料文件过大或不是普通文件。');
    if (Object.keys(files).length >= 4096) throw new Error('共享资料数量超过安全处理上限。');
    files[rel] = S.hash(FS.readFileSync(file));
  };
  if (FS.existsSync(S.inside(root, 'profile.md'))) add('profile.md');
  const walk = rel => {
    const dir = S.inside(root, rel);
    if (!FS.existsSync(dir)) return;
    for (const entry of FS.readdirSync(dir, { withFileTypes: true })) {
      const child = rel + '/' + entry.name;
      S.inside(root, child);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.md')) add(child);
    }
  };
  SHARED.forEach(walk);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
function journalPath(root, token) { return S.inside(root, '.therapy/memory-journal/' + S.uuid(token) + '.json'); }

/** 仅对可确认属于本事务的文件回滚；外部另有修改时停止，保留证据而不覆盖用户。 */
function recover(root, token) {
  const file = journalPath(root, token);
  if (!FS.existsSync(file)) return;
  const journal = S.read(file), id = S.uuid(journal.session_id);
  if (journal.schema !== 1 || journal.id !== token || !Array.isArray(journal.changes)) throw new Error('共享保存恢复资料损坏。');
  const committed = revision(root).commit_id === token;
  for (const c of journal.changes) {
    if (!allowed(c.path, id, journal.mode)) throw new Error('恢复资料包含未授权的写入目标。');
    const target = S.inside(root, c.path), now = FS.existsSync(target) ? S.hash(FS.readFileSync(target)) : null;
    const beforeHash = c.before === null ? null : S.hash(c.before);
    if (!committed && now !== beforeHash && now !== c.after_hash) throw new Error('恢复目标又被外部修改，未自动覆盖。');
  }
  if (committed) {
    const value = state(root, id); delete value.base; value.last_commit = journal.result; S.json(statePath(root, id), value);
  } else {
    for (const c of journal.changes) {
      const target = S.inside(root, c.path);
      if (c.before !== null) S.atomic(target, c.before);
      else if (FS.existsSync(target)) FS.unlinkSync(target);
    }
  }
  FS.unlinkSync(file);
  LOG?.writeEvent(root, { component: 'memory', event: committed ? 'memory.recovery_completed' : 'memory.rolled_back', session_id: id });
}

/** 确认旧进程死亡后，在独立恢复锁下回收；恢复完成前旧写锁一直存在，避免双重抢占。 */
function acquire(root) {
  const file = S.inside(root, LOCK), own = { pid: process.pid, token: CRYPTO.randomUUID() };
  FS.mkdirSync(PATH.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = FS.openSync(file, 'wx', 0o600);
    try { FS.writeFileSync(fd, JSON.stringify(own)); }
    catch (err) { FS.unlinkSync(file); throw err; }
    finally { FS.closeSync(fd); }
    return own;
  } catch (err) { if (err.code !== 'EEXIST') throw err; }
  const recoveryFile = S.inside(root, '.therapy/memory-recovery.lock');
  let fd;
  try { fd = FS.openSync(recoveryFile, 'wx', 0o600); }
  catch { throw new Error('其他客户端正在保存或恢复共享资料，请稍后重试。'); }
  try {
    const previous = S.read(file);
    if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error('共享写锁身份无效，未擅自移除。');
    try { process.kill(previous.pid, 0); throw new Error('其他客户端正在保存共享资料，请稍后重试。'); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
    recover(root, S.uuid(previous.token));
    S.json(file, own);
    return own;
  } finally { FS.closeSync(fd); FS.unlinkSync(recoveryFile); }
}
function release(root, own) {
  // 恢复尚未完成时保留锁及日志；进程结束后由下一次明确保存请求尝试恢复。
  if (FS.existsSync(journalPath(root, own.token))) return;
  const file = S.inside(root, LOCK);
  if (FS.existsSync(file) && S.read(file).token === own.token) FS.unlinkSync(file);
}

/** 开始保存只取得基线哈希，不复制正文；返回的本会话文件名避免同日多窗口相互覆盖。 */
function begin(root, id) {
  id = S.uuid(id);
  const selected = mode(root, id), own = acquire(root);
  try {
    const value = state(root, id);
    const current = revision(root), files = inventory(root), token = CRYPTO.randomUUID();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    value.base = { token, revision: current.revision, fingerprint: S.hash(JSON.stringify(files)) };
    S.json(statePath(root, id), value);
    const draft = '.therapy/memory-drafts/' + id + '/' + token + '.json';
    return { ok: true, base_token: token, revision: current.revision, mode: selected, date, draft: S.inside(root, draft), summary: (selected === 'friend' ? 'friend-sessions/' : 'sessions/') + date + '-' + id + '.md', hypotheses: selected === 'friend' ? 'friend-hypotheses/' + date + '-' + id + '.md' : null };
  } finally { release(root, own); }
}

/** 只提交本会话候选稿；版本或内容基线变化一律拒绝，由模型重读并重新准备变更。 */
function commit(root, id, draftFile) {
  id = S.uuid(id);
  let value = state(root, id);
  const rel = PATH.relative(PATH.resolve(root), PATH.resolve(draftFile)).replaceAll('\\', '/');
  if (!new RegExp('^\\.therapy/memory-drafts/' + id + '/[0-9a-f-]{36}\\.json$').test(rel)) throw new Error('候选稿不属于当前会话。');
  const file = S.inside(root, rel);
  if (!FS.existsSync(file) && value.last_commit?.draft === rel) return { ok: true, repeated: true, ...value.last_commit };
  if (FS.statSync(file).size > 16 * 1024 * 1024) throw new Error('共享资料候选稿超过大小限制。');
  const draft = S.read(file), selected = mode(root, id);
  if (draft.schema !== 1 || !Array.isArray(draft.changes) || !draft.changes.length || draft.changes.length > 64) throw new Error('候选稿必须包含 1 至 64 个明确变更。');
  const seen = new Set();
  for (const c of draft.changes) {
    if (!allowed(c.path, id, selected) || seen.has(c.path) || typeof c.content !== 'string' || Buffer.byteLength(c.content) > 8 * 1024 * 1024) throw new Error('候选稿包含不允许、重复或过大的目标。');
    seen.add(c.path); S.inside(root, c.path);
  }
  const own = acquire(root);
  try {
    value = state(root, id);
    const current = revision(root);
    // 发布后进程可能来不及返回；相同候选稿的重试只确认旧提交，不再次修改共享资料。
    if (value.last_commit?.base_token === draft.base_token && value.last_commit.draft === rel && value.last_commit.draft_hash === S.hash(JSON.stringify(draft))) {
      FS.unlinkSync(file); return { ok: true, repeated: true, ...value.last_commit };
    }
    if (!value.base || draft.base_token !== value.base.token || value.base.revision !== current.revision || value.base.fingerprint !== S.hash(JSON.stringify(inventory(root)))) {
      LOG?.writeEvent(root, { component: 'memory', event: 'memory.conflict', level: 'warn', session_id: id, client: value.client });
      throw new Error('共享资料已变化或保存基线失效。请重新 begin，重读最新资料并重新合并，不能直接重试旧稿。');
    }
    const result = { commit_id: own.token, base_token: draft.base_token, revision: current.revision + 1, files: [...seen], draft: rel, draft_hash: S.hash(JSON.stringify(draft)) };
    const journal = { schema: 1, id: own.token, session_id: id, mode: selected, result, changes: draft.changes.map(c => ({ path: c.path, before: FS.existsSync(S.inside(root, c.path)) ? FS.readFileSync(S.inside(root, c.path), 'utf8') : null, after_hash: S.hash(c.content) })) };
    S.json(journalPath(root, own.token), journal);
    try {
      for (const c of draft.changes) S.atomic(S.inside(root, c.path), c.content);
      S.json(S.inside(root, REVISION), { schema: 1, revision: result.revision, commit_id: own.token });
      delete value.base; value.last_commit = result; S.json(statePath(root, id), value);
      FS.unlinkSync(journalPath(root, own.token));
    } catch (err) { recover(root, own.token); throw err; }
    FS.unlinkSync(file);
    LOG?.writeEvent(root, { component: 'memory', event: 'memory.committed', session_id: id, client: value.client });
    return { ok: true, ...result };
  } finally { release(root, own); }
}

/** 提取工具实际涉及的路径；补丁需要逐个检查目标，不把补丁正文当共享资料写入权限。 */
function touched(payload) {
  const tool = payload.tool_name || '', input = payload.tool_input || {};
  if (tool === 'apply_patch') return [...String(input.command || input.patch || input.input || '').matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File:|Move to:) (.+)$/gm)].map(m => m[1].trim());
  return [input.file_path || input.path || ''].filter(Boolean);
}
function protectedData(root, file) {
  const rel = PATH.relative(PATH.resolve(root), PATH.resolve(root, file)).replaceAll('\\', '/');
  return rel === 'profile.md' || SHARED.some(dir => rel === dir || rel.startsWith(dir + '/'));
}

/** 提示与工具保护共同约束普通保存；它是客户端工具兜底，不作为操作系统安全沙箱。 */
function denied(root, payload, id) {
  const tool = payload.tool_name || '', input = payload.tool_input || {};
  const paths = touched(payload), write = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'].includes(tool);
  if (paths.some(p => protectedData(root, p)) && FS.existsSync(S.inside(root, LOCK))) return '共享资料正在保存或等待恢复，请稍后通过共享保存工具检查，不读取半完成资料。';
  if (write && paths.some(p => protectedData(root, p))) return '共享资料请先调用 shared-memory.cjs --begin，再准备候选稿并用 --commit 提交；不能直接改写档案、主题或摘要。';
  if (write && paths.some(p => /(?:^|[\\/])\.therapy[\\/](?:memory-state|memory-journal|shared-state\.json|memory-write\.lock|memory-recovery\.lock)/.test(p))) return '共享保存状态只能由本地工具维护，不能直接改写。';
  if (write && paths.some(p => {
    const match = p.replaceAll('\\', '/').match(/\.therapy\/memory-drafts\/([^/]+)\//);
    return match && match[1] !== id;
  })) return '不能改写其他会话的共享资料候选稿。';
  if (tool === 'Bash') {
    const command = String(input.command || '').replaceAll('\\', '/');
    const writes = /(?:\b(?:rm|mv|cp|del|copy|move|tee|out-file|set-content|add-content|remove-item|move-item|copy-item|new-item)\b|writefilesync|appendfilesync|writefile|appendfile|\.write_text\b|\s>{1,2})/i.test(command);
    const mentionsData = /(?:profile\.md|(?:^|[\s/"'])context(?:\/|[\s"'])|(?:friend-)?sessions\/|friend-hypotheses\/)/i.test(command);
    // Codex 通常通过执行工具读取文件，也要阻止它在另一事务发布途中读取半完成资料。
    if (mentionsData && FS.existsSync(S.inside(root, LOCK))) return '共享资料正在保存或等待恢复，请稍后通过共享保存工具检查。';
    if (writes && mentionsData) return '命令会直接改写共享资料，请使用共享保存工具提交候选稿。';
  }
  return null;
}

/** 每轮只注入版本和协议位置；变化提示引导按需重读，不实时复制正文或重置模式。 */
function runHook(root, payload) {
  const id = S.uuid(payload.session_id), event = payload.hook_event_name;
  if (event === 'PreToolUse') {
    const reason = denied(root, payload, id);
    if (reason) LOG?.writeEvent(root, { component: 'memory', event: 'tool.denied', level: 'warn', session_id: id, client: payload.client || 'claude-code', tool_name: payload.tool_name, error: { code: 'POLICY_DENIED' } });
    return reason ? { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
  }
  if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return {};
  const file = statePath(root, id), value = FS.existsSync(file) ? state(root, id) : { schema: 1, session_id: id };
  value.client = payload.client || 'claude-code'; value.native_session_id = payload.native_session_id || id;
  delete value.base; S.json(file, value);
  const current = revision(root);
  return { hookSpecificOutput: { hookEventName: event, additionalContext: 'INNER_DIALOGUE_MEMORY ' + JSON.stringify({ session_id: id, client: value.client, revision: current.revision, project_root: root, protocol: PATH.join(root, '.therapy/shared-memory-protocol.md') }) + '\n先读取共享资料规则。与上一轮版本不同时重读已变化的档案、索引和相关摘要。所有共享写入使用 begin/commit；旧咨询正文的日期摘要路径由本协议返回的会话独立路径替代，其他业务规则不变。' } };
}

/** 命令只接受 begin/status/commit；钩子失败明确报告，工具检查失败时拒绝写入。 */
async function main() {
  const root = PATH.resolve(__dirname, '..', '..'), args = process.argv.slice(2);
  let payload, id;
  try {
    if (!args.length) { payload = await S.input(); id = payload.session_id; const out = runHook(root, payload); if (Object.keys(out).length) process.stdout.write(JSON.stringify(out) + '\n'); return; }
    if (!['--begin', '--status', '--commit'].includes(args[0]) || args[1] !== '--session' || ![3, 5].includes(args.length) || (args[0] === '--commit' ? args[3] !== '--draft' : args.length !== 3)) throw new Error('共享保存参数不正确。');
    id = S.uuid(args[2]);
    const out = args[0] === '--begin' ? begin(root, id) : args[0] === '--commit' ? commit(root, id, args[4]) : { ok: true, ...revision(root), session: state(root, id) };
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (err) {
    LOG?.writeEvent(root, { component: 'memory', event: 'memory.failure', level: 'error', session_id: id, error: err });
    if (args.length) { process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n'); process.exitCode = 1; }
    else if (payload?.hook_event_name === 'PreToolUse') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '共享资料检查失败，请先检查本地配置。' } }) + '\n');
    else process.stderr.write('共享资料上下文加载失败，请检查运行日志。\n');
  }
}
module.exports = { begin, commit, revision, inventory, allowed, recover, denied, runHook, touched };
if (require.main === module) main();
