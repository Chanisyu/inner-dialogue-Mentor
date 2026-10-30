// <!-- version: 1.0.0 -->
/**
 * Codex 主对话的生命周期适配。共用原模式、归档和共享资料逻辑，只转换客户端边界。
 * 安全与统计仍调用已安装的原脚本，不改写冻结的咨询依赖；子 Agent 不代替用户会谈。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const CP = require('node:child_process');
const S = require('./local-storage.cjs');
const CODEX = require('./codex-transcript.cjs');
const MODE = require('./session-mode.cjs');
const ARCHIVE = require('./transcript-archive.cjs');
const MEMORY = require('./shared-memory.cjs');
const LOG = require('./runtime-log.cjs');

/** 将旧脚本的输出转换成当前事件上下文；超时或格式错误明确记录，正文不写技术日志。 */
function legacy(root, script, payload) {
  const file = PATH.join(root, '.therapy/hooks', script);
  if (!FS.existsSync(file)) throw new Error('所需的原有咨询辅助脚本缺失。');
  const result = CP.spawnSync(process.execPath, [file], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  if (result.error || result.status !== 0) throw new Error('原有咨询辅助脚本运行失败。');
  const raw = result.stdout.trim();
  if (!raw) return '';
  try { return JSON.parse(raw).hookSpecificOutput?.additionalContext || ''; }
  catch { return raw; }
}

/** 已知分支继承父对话的真实设置；已经保存的 Codex 会话始终优先使用自身锁定状态。 */
function inherit(root, payload) {
  const config = PATH.join(root, '.therapy/interaction.json');
  if (!FS.existsSync(config) || !S.read(config).enabled || MODE.readState(root, payload.session_id)) return;
  const info = CODEX.source(payload.transcript_path, payload.native_session_id);
  if (info.parent_thread_id) {
    const previous = MODE.readState(root, CODEX.conversationId(info.parent_thread_id));
    if (!previous) throw new Error('Codex 分支的父会话设置不可恢复，不能重新猜测模式。');
    MODE.selectState(root, payload.session_id, MODE.validateChoice(previous), 'codex-inherited');
  }
}

/** 工具输入按实际操作检查：补丁逐个验证文件，统一执行命令补齐 command 字段。 */
function toolPayload(payload) {
  const input = payload.tool_input || {};
  return { ...payload, tool_input: { ...input, ...(input.cmd && !input.command ? { command: input.cmd } : {}) } };
}

/** 只转换事件，不生成对话正文；正常 Stop 没有归档请求时不保存文件。 */
function runHook(root, raw) {
  if (raw.agent_id) return {};
  const payload = toolPayload(CODEX.normalize(raw, root)), event = payload.hook_event_name;
  inherit(root, payload);
  if (['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd'].includes(event)) {
    const failed = event === 'PostToolUse' && (payload.tool_response?.is_error === true || Number(payload.tool_response?.exit_code) > 0);
    LOG.observe({ ...payload, ...(failed ? { hook_event_name: 'PostToolUseFailure', error: { code: 'TOOL_ERROR' } } : {}) }, root);
  }
  if (event === 'PreToolUse') {
    const guarded = MEMORY.runHook(root, payload);
    if (guarded.hookSpecificOutput?.permissionDecision === 'deny') return guarded;
    if (payload.tool_name === 'apply_patch') {
      for (const file of MEMORY.touched(payload)) {
        if (/(?:^|[\\/])(?:AGENTS\.md|\.codex[\\/](?:hooks\.json|config\.toml))$/i.test(file)) return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: '对话中不能改写客户端入口和钩子配置。' } };
        const out = MODE.runHook({ ...payload, tool_name: 'Write', tool_input: { file_path: file } }, root);
        if (out.hookSpecificOutput?.permissionDecision === 'deny') return out;
      }
      return {};
    }
    return MODE.runHook(payload, root);
  }
  if (['Stop', 'Interrupt', 'PreCompact'].includes(event)) {
    ARCHIVE.runHook(root, payload);
    return {};
  }
  if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return {};
  const contexts = [MODE.runHook(payload, root), ARCHIVE.runHook(root, payload), MEMORY.runHook(root, payload)].map(out => out.hookSpecificOutput?.additionalContext).filter(Boolean);
  if (event === 'SessionStart') {
    const usage = legacy(root, 'usage-stats.js', payload);
    if (usage) contexts.push(usage);
    contexts.push('本条是 Codex 中独立开启的本咨询师对话。恢复使用原锁定；其他客户端未保存的对话不会实时进入本窗口。');
  } else {
    const safety = legacy(root, 'safety-net.js', payload);
    if (safety) contexts.push(safety);
  }
  return { hookSpecificOutput: { hookEventName: event, additionalContext: contexts.join('\n') } };
}

/** 配置或来源失效时显式阻止继续初始化；工具检查失败按拒绝返回，不静默放行写入。 */
async function main() {
  const root = PATH.resolve(__dirname, '..', '..');
  let payload;
  try {
    payload = await S.input();
    const out = runHook(root, payload);
    if (Object.keys(out).length) process.stdout.write(JSON.stringify(out) + '\n');
  } catch (err) {
    LOG.writeEvent(root, { component: 'codex', event: 'client.failure', level: 'error', client: 'codex', error: err });
    if (payload?.hook_event_name === 'PreToolUse') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Codex 咨询目录检查失败，请先检查配置和会话来源。' } }) + '\n');
    else if (['SessionStart', 'UserPromptSubmit'].includes(payload?.hook_event_name)) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: 'INNER_DIALOGUE_ERROR Codex 启动检查失败；请停止加载咨询或朋友资料，检查钩子和原始记录来源。' } }) + '\n');
    else process.stderr.write('Codex 对话辅助处理未完成，请检查运行日志。\n');
  }
}
module.exports = { runHook, toolPayload };
if (require.main === module) main();
