/*
 * 可选多模式的本地会话状态与钩子；兼容既有 dual-mode 安装与状态格式。
 * 此脚本会直接复制到安装目录；仅依赖 Node 内置模块，不依赖源码位置。
 * 只保存会话设置，不保存聊天正文；临床规则仍由原咨询入口负责。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const CRYPTO = require('node:crypto');
// 老安装可能尚未复制日志模块；记录能力缺失不能使原有模式锁定失效。
let RUNTIME_LOG;
try { RUNTIME_LOG = require('./runtime-log.cjs'); } catch { RUNTIME_LOG = null; }

/** 只传入固定操作名和必要元数据，原始聊天、命令及状态正文不会传给日志器。 */
function record(root, entry) { return RUNTIME_LOG?.writeEvent(root, { component: 'session-mode', ...entry }); }

const PERSONAS = Object.freeze(['warm-talkative', 'light-humor', 'rational-companion', 'interest-companion']);
const LENGTHS = Object.freeze(['concise', 'standard', 'detailed', 'deep']);
// 模式枚举只增加助手分支；既有会话仍按原值恢复，不隐式迁移已锁定选择。
const MODES = Object.freeze(['counseling', 'friend', 'assistant']);
const LOCK_MARKER = 'INNER_DIALOGUE_LOCK ';

/** 校验真实会话 UUID，禁止路径分隔符或任意文件名成为写入位置。 */
function sessionId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('缺少有效的 Claude Code 会话 ID；不能伪造或用日期代替。');
  }
  return value.toLowerCase();
}

/** 只有朋友模式接受人格和篇幅；助手与咨询均拒绝这些参数，避免残留配置串入。 */
function validateChoice(choice) {
  if (!choice || !MODES.includes(choice.mode)) throw new Error('模式必须是 friend、counseling 或 assistant。');
  if (choice.mode !== 'friend') {
    if (choice.persona !== undefined || choice.length !== undefined) throw new Error((choice.mode === 'assistant' ? '助手' : '咨询') + '模式不能设置朋友人格或回复长度。');
    return { mode: choice.mode };
  }
  if (!PERSONAS.includes(choice.persona)) throw new Error('请选择有效的朋友人格。');
  if (!LENGTHS.includes(choice.length)) throw new Error('请选择有效的朋友回复长度。');
  return { mode: 'friend', persona: choice.persona, length: choice.length };
}

/** 安装级配置必须存在并启用；普通咨询安装不运行本功能。 */
function config(root) {
  const file = PATH.join(root, '.therapy', 'interaction.json');
  if (!FS.existsSync(file)) return null;
  const value = JSON.parse(FS.readFileSync(file, 'utf8'));
  if (value.schema_version !== 1 || value.enabled !== true) throw new Error('双模式配置损坏或未启用，请运行 dual-mode --status 检查。');
  return value;
}

/** 读取并严格校验已锁定状态；损坏时不回退成可重新选择的空状态。 */
function readState(root, id) {
  id = sessionId(id);
  const file = PATH.join(root, '.therapy', 'conversations', id + '.json');
  if (!FS.existsSync(file)) return null;
  if (FS.statSync(file).size > 16384) throw new Error('会话状态大小异常，已停止恢复。');
  const value = JSON.parse(FS.readFileSync(file, 'utf8'));
  if (value.schema_version !== 1 || value.session_id !== id || value.locked !== true) throw new Error('会话状态损坏，不能重新选择覆盖。');
  return { ...value, ...validateChoice(value) };
}

/**
 * 一次性发布完整 JSON：临时文件写完后用同目录硬链接排他发布。
 * 两个同时提交的请求只有一个成功，读取方不会看到半写入的状态。
 */
function selectState(root, id, choice, origin = 'selected') {
  if (!config(root)) throw new Error('此目录尚未启用双模式。');
  id = sessionId(id);
  const selected = validateChoice(choice);
  const old = readState(root, id);
  if (old) return sameOrReject(old, selected);
  const dir = PATH.join(root, '.therapy', 'conversations');
  FS.mkdirSync(dir, { recursive: true });
  const target = PATH.join(dir, id + '.json');
  const temp = PATH.join(dir, '.' + id + '-' + CRYPTO.randomBytes(8).toString('hex') + '.tmp');
  const state = { schema_version: 1, session_id: id, locked: true, ...selected, origin, selected_at: new Date().toISOString() };
  try {
    FS.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { FS.linkSync(temp, target); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return sameOrReject(readState(root, id), selected);
    }
  } finally {
    if (FS.existsSync(temp)) FS.unlinkSync(temp);
  }
  record(root, { event: 'mode.selected', session_id: id, mode: selected.mode });
  return state;
}

/** 同一选择可以重试；任何模式、人格或篇幅差异均拒绝覆盖。 */
function sameOrReject(state, selected) {
  if (!state || JSON.stringify(validateChoice(state)) !== JSON.stringify(selected)) {
    throw new Error('本对话设置已永久锁定，不能更改模式、人格或篇幅；请新建没有历史的对话。');
  }
  return state;
}

/**
 * 历史分支只继承真实钩子附件里的锁定标记，不解析用户正文中的伪造标记。
 * 旧咨询根指令或实际读取咨询人格的历史说明此窗口已加载咨询，不可改成朋友。
 */
function inheritedChoice(transcript) {
  if (!transcript || !FS.existsSync(transcript)) return null;
  if (FS.statSync(transcript).size > 16 * 1024 * 1024) throw new Error('历史过大，无法可靠判断模式，请新建干净对话。');
  let inherited = null;
  let legacy = false;
  for (const line of FS.readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === 'attachment') {
      const a = record.attachment || {};
      if (a.type === 'hook_additional_context') {
        const contents = Array.isArray(a.content) ? a.content : [a.content];
        for (const text of contents) {
          if (typeof text !== 'string' || !text.startsWith(LOCK_MARKER)) continue;
          try {
            const raw = JSON.parse(text.slice(LOCK_MARKER.length).split('\n')[0]);
            const prior = validateChoice(raw);
            if (inherited && JSON.stringify(inherited) !== JSON.stringify(prior)) throw new Error('历史中有冲突的模式标记。');
            inherited = prior;
          } catch (err) { throw new Error('历史模式标记无法可靠恢复：' + err.message); }
        }
      }
      if (a.type === 'instructions' && Array.isArray(a.files)) {
        for (const file of a.files) {
          if (typeof file.content === 'string' && file.content.includes('## 会谈启动流程') && !file.content.includes('inner-dialogue-dual-mode:')) legacy = true;
        }
      }
    }
    const blocks = record.type === 'assistant' ? record.message?.content : null;
    if (Array.isArray(blocks) && blocks.some(b => b.type === 'tool_use' && b.name === 'Read' && /[\\/]\.therapy[\\/]persona\.md$/i.test(b.input?.file_path || ''))) legacy = true;
  }
  return inherited ? { choice: inherited, origin: 'inherited' } : legacy ? { choice: { mode: 'counseling' }, origin: 'legacy-counseling' } : null;
}

/** 优先恢复持久状态，再尝试从历史分支继承；禁止凭措辞猜测既有模式。 */
function resolveState(root, payload) {
  const id = sessionId(payload.session_id);
  const saved = readState(root, id);
  if (saved) return saved;
  const inherited = inheritedChoice(payload.transcript_path);
  return inherited ? selectState(root, id, inherited.choice, inherited.origin) : null;
}

/** 将朋友背景资料定位到安装根目录，避免把规则所在的 .therapy 当成资料根目录。 */
function friendPaths(root) {
  const projectRoot = PATH.resolve(root);
  return {
    project_root: projectRoot,
    profile: PATH.join(projectRoot, 'profile.md'),
    context_index: PATH.join(projectRoot, 'context', 'index.md'),
    sessions: PATH.join(projectRoot, 'sessions'),
    friend_sessions: PATH.join(projectRoot, 'friend-sessions'),
    friend_hypotheses: PATH.join(projectRoot, 'friend-hypotheses'),
    assistant_sessions: PATH.join(projectRoot, 'assistant-sessions'),
    transcript_index: PATH.join(projectRoot, 'transcripts', 'index.json'),
    original_materials: PATH.join(projectRoot, '原始材料'),
  };
}

/**
 * 将当前状态压成必要提示；咨询提示仍保持原文，不包含朋友设置或资料路径。
 * 朋友分支逐次提供安装根目录下的绝对路径，恢复或工作目录变化后也无需猜测。
 */
function contextFor(id, state, root = PATH.resolve(__dirname, '..', '..')) {
  if (!state) return 'INNER_DIALOGUE_PENDING ' + JSON.stringify({ session_id: id }) + '\n尚未选择。按 CLAUDE.md 先选模式；未明确两项朋友设置前不能擅自锁定。';
  const choice = { session_id: id, ...validateChoice(state) };
  const text = LOCK_MARKER + JSON.stringify(choice);
  if (state.mode === 'counseling') return text + '\n咨询模式已锁定。完整读取 .therapy/modes/counseling.md，按原咨询正文执行。本对话不调整模式、人格或篇幅。';
  // 此分支只注入资料导航与保存协议位置，不复用朋友或咨询的身份、风格和篇幅正文。
  if (state.mode === 'assistant') return text + '\n读取 .therapy/modes/assistant.md，并按 .therapy/assistant-memory.md 处理明确的保存请求。' +
    '\nINNER_DIALOGUE_PATHS ' + JSON.stringify(friendPaths(root));
  return text + '\n朋友模式已锁定。读取 .therapy/modes/friend.md、.therapy/friend-personas/' + state.persona + '.md、.therapy/friend-lengths/' + state.length + '.md。不得加载咨询人格或疗法；任何设置调整需新建对话。' +
    '\nINNER_DIALOGUE_PATHS ' + JSON.stringify(friendPaths(root)) +
    '\n背景资料使用上列绝对路径；profile.md、context 和会谈目录与根 CLAUDE.md 同级，不在 .therapy 中。读取失败时核对这些路径并重试，不得把读取失败当作没有历史或声称已读。';
}

/**
 * 防止常用读取工具串入另一分支，也阻止对话内直接改写咨询资产或状态。
 * 这是工具调用兜底而非操作系统沙箱；不声称能抵御任意手工 shell 绕过。
 */
function deniedTool(root, payload, state) {
  const name = payload.tool_name || '';
  const input = payload.tool_input || {};
  const raw = String(input.file_path || input.path || input.command || '').replaceAll('\\', '/');
  const text = raw.toLowerCase();
  const clinical = /\.therapy\/(persona\.md|modalities(?:\/|\b)|session-structure\.md|modes\/counseling\.md|library\/(?:personas|modalities|structures)(?:\/|\b))/.test(text) || /\.therapy\/\*/.test(text);
  const friend = /\.therapy\/(friend-personas(?:\/|\b)|friend-lengths(?:\/|\b)|friend-memory\.md|modes\/friend\.md)/.test(text);
  const assistant = /\.therapy\/(assistant-memory\.md|modes\/assistant\.md)/.test(text);
  const protectedAsset = /\.therapy\/(archive-state\/|archive-version\.json|memory-state\/|memory-journal\/|shared-state\.json|conversations\/|interaction\.json|modes\/|friend-personas\/|friend-lengths\/|(?:friend|assistant)-memory\.md|persona\.md|modalities\/|session-structure\.md|commands\.md|.*protocol\.md|client-entry\.md|hooks\/)/.test(text) || /(?:^|\/)(?:claude|agents)\.md\b/.test(text) || /\.(?:claude\/settings\.json|codex\/(?:hooks\.json|config\.toml))/.test(text);
  const writeTool = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name);
  // 针对已发生的朋友启动路径错误给出正确位置；不复制、迁移或另建同名个人资料。
  // 只检查资料工具的目标路径，不把搜索正文或普通聊天中的路径示例当成文件操作。
  const backgroundPath = String(input.file_path || input.path || input.pattern || '').replaceAll('\\', '/').toLowerCase();
  const misplacedBackground = /(?:^|\/)\.therapy\/(?:profile\.md\b|(?:context|sessions|friend-sessions|friend-hypotheses|assistant-sessions|transcripts)(?:\/|$))/.test(backgroundPath);
  const backgroundMode = ['friend', 'assistant'].includes(state?.mode);
  if (backgroundMode && ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit'].includes(name) && misplacedBackground) {
    return '背景资料不在 .therapy 中。请使用安装根目录下的正确路径：' + JSON.stringify(friendPaths(root)) + '。读取失败后应纠正路径重试，不得新建错误位置的档案或索引。';
  }
  // 朋友搜索限定在背景或明确文件，避免全目录搜索把咨询配置片段带入上下文。
  if (backgroundMode && name === 'Grep' && (!input.path || PATH.resolve(root, input.path) === PATH.resolve(root))) return '资料搜索请限定到 profile.md、sessions、context 或明确的背景文件。';
  if (writeTool && protectedAsset) return '锁定对话不能修改模式状态或咨询配置；请在项目管理中处理。';
  if (!state && (clinical || friend || assistant || /(?:profile\.md|sessions\/|context\/)/.test(text))) return '尚未完成模式选择，先按入口完成选择。';
  // 助手可读取旧交流资料，但不加载会塑造咨询／朋友行为的规则与使用节奏建议。
  if (state?.mode === 'assistant' && (clinical || friend || /\.therapy\/(commands\.md|profile-protocol\.md|usage-reflection\.md|library(?:\/|\b))/.test(text))) return '助手模式只读取个人资料、相关历史和公共保存协议，不加载咨询或朋友行为配置。';
  if (state && state.mode !== 'assistant' && assistant) return '当前模式不加载助手分支的资料入口或保存规则。';
  if (state?.mode === 'friend' && clinical) return '朋友模式不能读取或加载咨询人格、疗法、结构或咨询入口。';
  if (state?.mode === 'counseling' && friend) return '咨询模式不能加载朋友人格、篇幅或朋友交流规则。';
  // 不拦截合法的一次性设置命令；其写入路径由脚本严格校验并排他发布。
  if (name === 'Bash' && protectedAsset && !text.includes('session-mode.cjs') && /(?:\b(?:rm|mv|cp|del|copy|move|tee)\b|writefile|appendfile|\s>)/.test(text)) return '禁止在对话中改写锁定状态或咨询资产。';
  return null;
}

/** 根据钩子事件恢复上下文或给出明确拒绝；普通安装返回空对象。 */
function runHook(payload, root) {
  if (!config(root)) return {};
  const id = sessionId(payload.session_id);
  const state = resolveState(root, payload);
  const event = payload.hook_event_name || 'SessionStart';
  if (event === 'PreToolUse') {
    const reason = deniedTool(root, payload, state);
    if (reason) record(root, { event: 'tool.denied', level: 'warn', session_id: id, tool_name: payload.tool_name, file: payload.tool_input?.file_path || payload.tool_input?.path, error: { code: 'POLICY_DENIED' } });
    return reason ? { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
  }
  return { hookSpecificOutput: { hookEventName: event, additionalContext: contextFor(id, state, root) } };
}

/** 解析本地工具参数，只接受固定键，避免拼接 shell 或任意文件写入。 */
function argumentsFor(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--select', '--status'].includes(key)) out[key.slice(2)] = true;
    else if (['--root', '--session', '--mode', '--persona', '--length'].includes(key) && argv[i + 1] !== undefined) out[key.slice(2)] = argv[++i];
    else throw new Error('未知或缺少值的参数：' + key);
  }
  return out;
}

/** 命令行设置不读取 stdin；钩子 stdin 设置限时，避免错误注册挂住聊天。 */
async function main() {
  let event = 'SessionStart';
  let root = PATH.resolve(__dirname, '..', '..');
  let activeSession;
  try {
    const args = argumentsFor(process.argv.slice(2));
    root = PATH.resolve(args.root || PATH.join(__dirname, '..', '..'));
    activeSession = args.session;
    if (args.select || args.status) {
      const state = args.select ? selectState(root, args.session, { mode: args.mode, ...(args.persona !== undefined ? { persona: args.persona } : {}), ...(args.length !== undefined ? { length: args.length } : {}) }) : readState(root, args.session);
      process.stdout.write(JSON.stringify({ ok: true, state }) + '\n');
      return;
    }
    let raw = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error('钩子输入超时。')); }, 4000);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 1048576) { clearTimeout(timer); process.stdin.destroy(); reject(new Error('钩子输入过大。')); } });
      process.stdin.on('end', () => { clearTimeout(timer); resolve(); });
      process.stdin.on('error', err => { clearTimeout(timer); reject(err); });
    });
    const payload = JSON.parse(raw);
    activeSession = payload.session_id;
    event = payload.hook_event_name || event;
    process.stdout.write(JSON.stringify(runHook(payload, root)) + '\n');
  } catch (err) {
    record(root, { event: 'mode.failure', level: 'error', session_id: activeSession, hook_event: event, error: err instanceof SyntaxError ? err : { code: 'MODE_ERROR' } });
    if (process.argv.includes('--select') || process.argv.includes('--status')) {
      process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
      process.exitCode = 1;
    } else if (event === 'PreToolUse') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: '模式检查失败：' + err.message } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: 'INNER_DIALOGUE_ERROR 模式检查失败：' + err.message + ' 请停止启动，不得猜测设置。' } }) + '\n');
    }
  }
}
module.exports = { MODES, PERSONAS, LENGTHS, LOCK_MARKER, sessionId, validateChoice, readState, selectState, inheritedChoice, resolveState, contextFor, deniedTool, runHook };
if (require.main === module) main();
