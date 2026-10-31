// <!-- version: 1.0.0 -->
/**
 * 使用统计的输出适配层：原脚本仍负责记录，助手与未选模式不加载使用节奏建议。
 * 不修改冻结的 usage-stats.js，也不丢失原有统计；两个客户端共用同一判断。
 */
'use strict';
const FS = require('node:fs');
const PATH = require('node:path');
const CP = require('node:child_process');
const MODE = require('./session-mode.cjs');
const S = require('./local-storage.cjs');
const LOG = require('./runtime-log.cjs');

/** 配置或状态异常时不猜测分支；普通单模式安装继续保留既有统计提示。 */
function filter(root, payload, context) {
  const config = PATH.join(root, '.therapy/interaction.json');
  if (!FS.existsSync(config) || S.read(config).enabled !== true) return context;
  const selected = MODE.readState(root, payload.session_id);
  return selected && selected.mode !== 'assistant' ? context : '';
}

/** 每次只执行安装目录内原统计脚本，不接受外部脚本路径或任意命令。 */
function collect(root, payload) {
  const script = PATH.join(root, '.therapy/hooks/usage-stats.js');
  const result = CP.spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  if (result.error || result.status !== 0) throw new Error('使用统计脚本运行失败。');
  const raw = result.stdout.trim();
  const context = raw ? JSON.parse(raw).hookSpecificOutput?.additionalContext || '' : '';
  return filter(root, payload, context);
}

/** Claude 的兼容注册保留原脚本路径参数供安装检查识别；执行目标始终由安装根决定。 */
async function main() {
  const root = PATH.resolve(__dirname, '..', '..');
  try {
    if (process.argv.length !== 3 || PATH.resolve(process.argv[2]) !== PATH.join(root, '.therapy/hooks/usage-stats.js')) throw new Error('使用统计适配参数无效。');
    const payload = await S.input();
    if (payload.hook_event_name !== 'SessionStart') return;
    const context = collect(root, payload);
    if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }) + '\n');
  } catch (err) {
    // 统计辅助失败仍不阻止交流；仅写白名单技术错误，不把输入或原始异常写入日志。
    LOG.writeEvent(root, { component: 'usage', event: 'usage.context_failure', level: 'warn', error: err });
  }
}
module.exports = { filter, collect };
if (require.main === module) main();
