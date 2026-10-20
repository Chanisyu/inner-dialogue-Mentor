// 中文界面的共用词表。文件名、选项 slug 和 JSON 字段名仍是稳定的程序接口，
// 这里只翻译展示给用户的名称和诊断文本，避免界面本地化改变安装数据的结构。
export const PERSONA_LABELS = {
  'warm-4o': '温暖自然型（4o 风格）',
  'direct-challenging': '直接挑战型',
  'warm-supportive': '温暖支持型',
  coach: '行动教练型',
  'grounded-real': '务实真诚型',
  contemplative: '沉思留白型',
  philosophical: '哲学与存在探索型',
  creative: '创意探索型',
};

export const STRUCTURE_LABELS = {
  structured: '结构化', moderate: '适中', freeform: '自由式',
};

export const MODALITY_LABELS = {
  act: '接纳与承诺疗法（ACT）', cbt: '认知行为疗法（CBT）',
  cft: '慈悲聚焦疗法（CFT）', 'dbt-skills': '辩证行为疗法技能（DBT）',
  ifs: '内在家庭系统疗法（IFS）', 'ideal-parent-figure': '理想父母形象（IPF）',
  'lifespan-integration': '人生跨度整合（LI）',
  'motivational-interviewing': '动机式访谈（MI）', narrative: '叙事疗法',
  polyvagal: '多迷走神经理论知情工作', psychodynamic: '心理动力学疗法',
  sfbt: '焦点解决短期疗法（SFBT）', 'somatic-experiencing': '躯体体验（SE）',
};

// 核心模块保留原有诊断契约，方便调用者和既有回归测试识别结果。
// 到达 CLI 展示边界时才替换完整短语；路径、版本号和系统错误细节原样保留。
// 长短语先替换，防止“present”等短词破坏更具体的诊断信息。
const PHRASES = [
  // 设置合并的原因同样出现在 --json 中，只翻译说明而保留事件名和路径。
  ['settings.json is not valid JSON (', 'settings.json 不是有效 JSON（'],
  [') — left untouched. Fix the JSON syntax by hand, then re-run update to register the ', '），已保留原文件。请手工修复 JSON，再运行 update 注册'],
  ['settings.json is not a JSON object — left untouched. Fix the file by hand, then re-run update to register the ', 'settings.json 不是 JSON 对象，已保留原文件。请手工修复，再运行 update 注册'],
  ['"hooks" is not an object — left untouched; register the ', 'hooks 不是对象，已保留原文件；请手工注册'],
  ['"hooks.UserPromptSubmit" is not an array — left untouched; register the ', 'hooks.UserPromptSubmit 不是数组，已保留原文件；请手工注册'],
  ['"hooks.SessionStart" is not an array — left untouched; register the ', 'hooks.SessionStart 不是数组，已保留原文件；请手工注册'],
  ['settings.json no longer exists — merge skipped.', 'settings.json 已不存在，跳过合并。'],
  ['settings merge failed (', '设置合并失败（'],
  [') — settings.json left as-is.', '），settings.json 保持原样。'],
  [' A pre-merge backup was saved at ', ' 合并前备份位于 '],
  [' Register the ', ' 请手工注册'],
  [' manually, or fix the underlying issue and re-run update.', '，或修复问题后重新运行 update。'],
  [' manually.', '。'], [' already registered.', '已注册。'],
  ['safety-net hook', '安全钩子'], ['usage-stats hook', '使用统计钩子'],
  ['Unknown option ', '未知参数 '],
  [' does not take an argument', ' 不接受附加值'],
  [' argument missing', ' 缺少参数值'],
  ['is ambiguous.', '存在歧义。'],
  ['Non-interactive install missing flags:', '非交互安装缺少参数：'],
  ['Therapy folder already exists:', '咨询师目录已存在：'],
  ['Therapy folder not found:', '找不到咨询师目录：'],
  ['No therapy folder found at ', '找不到咨询师目录：'],
  ['Run `inner-dialogue install` first.', '请先运行本地中文版本的 install 命令。'],
  ['Use `inner-dialogue update` to update an existing install, or pass --force to reinstall.', '更新现有安装请使用 update；重新安装可使用 --force。'],
  ['profile.md has no H2 sections — the LLM has nothing to append updates under', 'profile.md 没有二级标题，模型无法按章节补充记录'],
  ['profile.md has no Background section (or equivalent). New profiles should seed with at least Background, Current Focus, and Notes — the LLM grows structure from there.', 'profile.md 缺少背景或同义章节。新档案应包含背景、当前关注和备注，后续再逐渐扩展。'],
  ['version.json uses legacy schema (no per-file hashes) — run `inner-dialogue update --force` to migrate', 'version.json 使用旧格式，缺少逐文件哈希；请先预览本地 update 的迁移计划，再决定是否覆盖。'],
  ['profile.md structure valid', 'profile.md 结构有效'],
  ['missing framework file:', '缺少框架文件：'],
  ['folder exists:', '目录存在：'],
  ['folder present', '目录存在'],
  ['folder missing', '目录缺失'],
  ['version.json present (kit ', 'version.json 存在（工具包 '],
  ['.therapy/version.json missing or unparseable', '.therapy/version.json 缺失或无法解析'],
  ['profile.md missing', '缺少 profile.md'],
  ['.therapy/ folder present', '.therapy/ 目录存在'],
  ['.therapy/ folder missing', '.therapy/ 目录缺失'],
  ['.claude/settings.json exists but is not valid JSON (', '.claude/settings.json 存在，但不是有效 JSON（'],
  [") — safety-net hook registration can't be verified, and updates will leave the file untouched rather than risk clobbering it. Fix the JSON syntax by hand (or restore from a .claude/settings.json.bak-* backup if one exists).", '），无法确认安全钩子注册。更新会保留此文件，请修正 JSON 语法，或从 .claude/settings.json.bak-* 恢复。'],
  [".claude/settings.json uses the legacy shell `date` command for the time hook — it is Mac-only and breaks on Windows. If you haven't customized this file, delete it and run `inner-dialogue update` to re-scaffold the cross-platform (Node) version.", '.claude/settings.json 的时间钩子仍使用旧 date 命令，在 Windows 上无法正常工作。若没有自定义，请备份后重建为跨平台 Node 版本。'],
  ['.claude/settings.json missing — without it the therapist has no signal for current local time (affects session pacing and time-of-day awareness). Run `inner-dialogue update` to scaffold it.', '缺少 .claude/settings.json，无法注入当前本地时间。请运行本地 update 创建配置。'],
  ["safety-net hook (.therapy/hooks/safety-net.js) has been modified from the shipped version. You're free to edit it, but we recommend you don't — the safety net is there for a reason, and edits can quietly break it. To restore the shipped version, run ", '安全钩子 .therapy/hooks/safety-net.js 与安装时记录的内容不同。修改可能影响匹配行为。恢复工具包版本可运行 '],
  ["usage-stats hook (.therapy/hooks/usage-stats.js) has been modified from the shipped version. It's a reflection aid rather than the safety net, so edits are lower-stakes — but they can skew the usage signal it records. To restore the shipped version, run ", '使用统计钩子 .therapy/hooks/usage-stats.js 已修改，可能影响统计信号。恢复工具包版本可运行 '],
  [' (note: --force also overwrites any other framework files you\'ve edited; a backup is taken first).', '（--force 也会覆盖其他已修改的框架文件，写入前会备份）。'],
  ['safety-net hook matches its installed version', '安全钩子与安装记录一致'],
  ['usage-stats hook matches its installed version', '使用统计钩子与安装记录一致'],
  ['safety-net hook registered in .claude/settings.json', '安全钩子已在 .claude/settings.json 注册'],
  ['usage-stats hook registered in .claude/settings.json', '使用统计钩子已在 .claude/settings.json 注册'],
  ['safety-net hook script missing (.therapy/hooks/safety-net.js) — the mechanical crisis-resource backstop is not installed. Run ', '缺少安全钩子 .therapy/hooks/safety-net.js，机械兜底未安装。运行 '],
  ['usage-stats hook script missing (.therapy/hooks/usage-stats.js) — the session-usage reflection signal is not installed. Run ', '缺少使用统计钩子 .therapy/hooks/usage-stats.js。运行 '],
  ['usage-reflection guidance missing (.therapy/usage-reflection.md) — the usage-pattern reflection prompt is not installed. Run ', '缺少使用节奏说明 .therapy/usage-reflection.md。运行 '],
  ['safety-net hook not registered in .claude/settings.json — the hook will not run on prompts even if the script is present. Run ', '安全钩子未在 .claude/settings.json 注册，脚本存在也不会触发。运行 '],
  ['usage-stats hook not registered in .claude/settings.json (SessionStart) — the hook will not run at session start even if the script is present. Run ', '使用统计钩子未在 .claude/settings.json 的 SessionStart 中注册。运行 '],
  [' to install it.', ' 安装。'], [' to register it.', ' 注册。'],
  [', which does not support the hook registration format this kit uses — the safety-net hook will not run on prompts even though everything is installed correctly. Update Claude Code: run ', '，不支持本工具包的钩子注册格式，安装完整也不会触发安全钩子。更新 Claude Code：运行 '],
  [' is older than ', ' 低于 '],
  [', or `npm i -g @anthropic-ai/claude-code@latest` if you installed via npm.', '；通过 npm 安装的版本也可运行 `npm i -g @anthropic-ai/claude-code@latest`。'],
  [' supports the safety-net hook (>= ', ' 支持安全钩子（最低版本 '],
  ['safety-net hook fired in a live check under ', '安全钩子在实际检查中已触发，运行环境：'],
  [' (no model call)', '（未调用模型）'],
  ['safety-net hook is registered but crashed when ', '安全钩子已注册，但在 '],
  [' ran it: ', ' 执行时崩溃：'],
  [' The hook will not run on prompts. ', ' 钩子无法正常响应输入。'],
  ['This confirms the Claude Code version warning above; updating Claude Code is the fix.', '请按上面的版本提示更新 Claude Code。'],
  ['Check the safety-net entry in .claude/settings.json, or run ', '检查 .claude/settings.json 的安全钩子条目，或运行 '],
  [' to restore it.', ' 恢复。'],
  ['safety-net hook did not report back within a few seconds when ', '安全钩子在以下环境执行后没有及时返回：'],
  [' ran it — it may be hanging or disabled (check for "disableAllHooks" in your Claude Code user settings).', '；可能挂起或被禁用，请检查用户配置中的 disableAllHooks。'],
  ['the live safety-net check reached the model instead of stopping first — its result is unreliable. Please report this at ', '安全钩子检查意外进入模型调用，结果不可靠。问题反馈：'],
  ['profile-protocol.md missing (.therapy/profile-protocol.md) — the profile provenance rules (dated writes + staleness review) are not installed. Run `inner-dialogue update` to install it.', '缺少 .therapy/profile-protocol.md，档案日期与复核规则未安装。请运行本地 update。'],
  ['context/index.md missing — the index routes the therapist to subject files (people, places, concepts, events). Run `inner-dialogue update` to scaffold it.', '缺少 context/index.md，无法索引人物、地点、概念与事件。请运行本地 update。'],
  ['context/ folder missing — the subject-level context library is a newer feature. Run `inner-dialogue update` to scaffold it.', '缺少 context/ 资料库，请运行本地 update 创建。'],
  ['Already up to date.', '已经是当前版本。'],
  ['modified since install', '安装后有本地修改'],
  ['unknown origin (pre-2.2.0 install or hand-placed file)', '来源未知，可能来自 2.2.0 之前的安装或手工文件'],
  ['unknown origin (no library source matched on hash)', '来源未知，没有哈希匹配的库文件'],
  ['customized active file', '已自定义的启用文件'],
  ['launcher file modified; left in place (no longer needed — use Claude AI app)', '启动器已修改，予以保留；可直接使用 Claude 应用启动会谈'],
  ['library source modalities/', '疗法库来源 modalities/'], [' no longer exists', ' 已不存在'],
  ['settings.json changed between planning and writing — merge skipped.', 'settings.json 在生成计划后发生变化，已跳过合并。'],
  ['unknown persona:', '未知人格：'], ['unknown structure:', '未知会谈结构：'],
  ['unknown modality:', '未知疗法：'], [' required', ' 为必填项'],
  [' present', ' 存在'],
].sort((a, b) => b[0].length - a[0].length);

// 仅处理诊断文字，不改动接口标识。先整句、后短语的替换顺序允许保留
// 插入其中的路径和版本号，也让未知平台错误仍能显示原始细节以便排查。
export function zhMessage(message) {
  let text = String(message);
  for (const [english, chinese] of PHRASES) text = text.replaceAll(english, chinese);
  return text;
}

// CLI 的普通输出与 --json 共用同一边界：字段名、状态码和路径不翻译；
// 只递归翻译人类可读的诊断字段，避免更改哈希、源路径或命令选项。
export function localizeResult(value, field = '') {
  if (Array.isArray(value)) return value.map((item) => localizeResult(item, field));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localizeResult(item, key)]));
  }
  return typeof value === 'string' && ['message', 'reason', 'error', 'errors', 'warnings', 'checks', 'detail'].includes(field)
    ? zhMessage(value) : value;
}
