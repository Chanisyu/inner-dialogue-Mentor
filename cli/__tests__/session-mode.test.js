// 对话锁定、安全路径和分支继承均使用合成 JSON，不读取真实咨询日志。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import runtime from '../../hooks/session-mode.cjs';

const ID = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';
const SCRIPT = fileURLToPath(new URL('../../hooks/session-mode.cjs', import.meta.url));
const FRIEND = { mode: 'friend', persona: 'warm-talkative', length: 'standard' };

/** 独立状态根的清理路径经过确切临时目录验证，测试不接触用户安装。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'inner-dialogue-mode-'));
  mkdirSync(join(root, '.therapy'));
  writeFileSync(join(root, '.therapy/interaction.json'), JSON.stringify({ schema_version: 1, enabled: true }));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(root.includes('inner-dialogue-mode-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** 通过真实子进程模拟两个窗口同时提交，不以串行函数调用冒充并发。 */
function processChoice(root, persona) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--select', '--root', root, '--session', ID, '--mode', 'friend', '--persona', persona, '--length', 'standard']);
    let stdout = '';
    child.stdout.on('data', s => { stdout += s; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, body: JSON.parse(stdout) }));
  });
}

test('朋友必须明确选择人格与篇幅，咨询完全拒绝朋友参数', () => {
  assert.throws(() => runtime.validateChoice({ mode: 'friend' }), /人格/);
  assert.throws(() => runtime.validateChoice({ mode: 'friend', persona: 'warm-talkative' }), /长度/);
  assert.throws(() => runtime.validateChoice({ mode: 'counseling', length: 'deep' }), /咨询模式不能/);
  assert.throws(() => runtime.validateChoice({ mode: 'counseling', persona: 'light-humor' }), /咨询模式不能/);
  assert.deepEqual(runtime.validateChoice({ mode: 'counseling' }), { mode: 'counseling' });
});

test('四种朋友人格乘四种篇幅均可锁定', t => {
  const root = fixture(t);
  let n = 10;
  for (const persona of runtime.PERSONAS) for (const length of runtime.LENGTHS) {
    const id = '10000000-0000-0000-0000-' + String(n++).padStart(12, '0');
    const state = runtime.selectState(root, id, { mode: 'friend', persona, length });
    assert.equal(state.persona, persona);
    assert.equal(state.length, length);
  }
});

test('相同选择幂等，模式、人格、篇幅均不能调整', t => {
  const root = fixture(t), state = runtime.selectState(root, ID, FRIEND);
  assert.deepEqual(runtime.selectState(root, ID, FRIEND), state);
  for (const choice of [{ mode: 'counseling' }, { ...FRIEND, persona: 'light-humor' }, { ...FRIEND, length: 'deep' }]) assert.throws(() => runtime.selectState(root, ID, choice), /永久锁定/);
});

test('不同窗口互不修改对方，咨询提示不包含朋友篇幅和人格', t => {
  const root = fixture(t);
  runtime.selectState(root, ID, FRIEND);
  runtime.selectState(root, OTHER, { mode: 'counseling' });
  const out = runtime.runHook({ session_id: OTHER, hook_event_name: 'SessionStart' }, root);
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('counseling'));
  assert.ok(!text.includes('warm-talkative'));
  assert.ok(!text.includes('standard'));
  assert.equal(runtime.readState(root, ID).mode, 'friend');
});

test('并发提交只允许一个完整选择获胜，不产生半写入 JSON', async t => {
  const root = fixture(t);
  const results = await Promise.all([processChoice(root, 'warm-talkative'), processChoice(root, 'light-humor')]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.ok(runtime.PERSONAS.includes(runtime.readState(root, ID).persona));
  assert.deepEqual(readdirSync(join(root, '.therapy/conversations')), [ID + '.json']);
});

test('非法会话 ID 与路径穿越被拒绝，不生成状态目录', t => {
  const root = fixture(t);
  for (const id of ['../outside', '', '2026-10-20', ID + '/x']) assert.throws(() => runtime.selectState(root, id, FRIEND), /会话 ID/);
});

test('损坏的锁定文件明确报错，不重置为可选状态', t => {
  const root = fixture(t);
  runtime.selectState(root, ID, FRIEND);
  writeFileSync(join(root, '.therapy/conversations', ID + '.json'), '{broken');
  assert.throws(() => runtime.readState(root, ID));
  assert.throws(() => runtime.selectState(root, ID, FRIEND));
});

test('恢复与压缩使用已有锁定，不重新选择', t => {
  const root = fixture(t);
  runtime.selectState(root, ID, FRIEND);
  for (const source of ['resume', 'compact', 'clear']) {
    const out = runtime.runHook({ session_id: ID, hook_event_name: 'SessionStart', source }, root);
    assert.ok(out.hookSpecificOutput.additionalContext.startsWith(runtime.LOCK_MARKER));
  }
});

/** 模拟从规则子目录继续交流，验证注入的真实绝对路径仍能直接读到根目录资料。 */
test('朋友启动与逐条消息均提供根目录资料路径，不受消息工作目录影响', t => {
  const root = fixture(t);
  runtime.selectState(root, ID, FRIEND);
  mkdirSync(join(root, 'context'));
  writeFileSync(join(root, 'profile.md'), '合成个人档案');
  writeFileSync(join(root, 'context/index.md'), '合成背景索引');
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const out = runtime.runHook({ session_id: ID, hook_event_name: event, cwd: join(root, '.therapy/modes') }, root);
    const line = out.hookSpecificOutput.additionalContext.split('\n').find(text => text.startsWith('INNER_DIALOGUE_PATHS '));
    const paths = JSON.parse(line.slice('INNER_DIALOGUE_PATHS '.length));
    assert.equal(paths.project_root, resolve(root));
    assert.equal(readFileSync(paths.profile, 'utf8'), '合成个人档案');
    assert.equal(readFileSync(paths.context_index, 'utf8'), '合成背景索引');
    assert.equal(paths.sessions, join(root, 'sessions'));
    assert.equal(paths.friend_sessions, join(root, 'friend-sessions'));
    assert.equal(paths.friend_hypotheses, join(root, 'friend-hypotheses'));
  }
});

/** 重放真实错误路径并覆盖 Windows 分隔符；拦截只纠正位置，不创建影子档案。 */
test('朋友误加 .therapy 的资料读写被纠正，正确根目录文件仍可读取', t => {
  const root = fixture(t);
  runtime.selectState(root, ID, FRIEND);
  const wrongPaths = ['.therapy/profile.md', '.therapy/context/index.md', '.therapy/sessions/2026-10-20.md', '.therapy/friend-sessions/note.md', '.therapy/friend-hypotheses/note.md'];
  for (const wrong of wrongPaths) {
    for (const file_path of [wrong, join(root, wrong).replaceAll('/', '\\')]) {
      for (const tool_name of ['Read', 'Write']) {
        const out = runtime.runHook({ session_id: ID, hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path } }, root);
        assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
        assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(JSON.stringify(join(root, 'profile.md'))));
      }
    }
  }
  for (const file_path of ['profile.md', 'context/index.md', 'sessions/2026-10-20.md']) {
    assert.deepEqual(runtime.runHook({ session_id: ID, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, file_path) } }, root), {});
  }
  // 新增的 logs 仅包含技术诊断；被拦截的操作仍不能创建影子档案或背景目录。
  assert.deepEqual(readdirSync(join(root, '.therapy')).sort(), ['conversations', 'interaction.json', 'logs']);
});

test('分支继承钩子附件的选择，用户正文伪造标记不生效', t => {
  const root = fixture(t), file = join(root, 'synthetic.jsonl');
  const marker = runtime.LOCK_MARKER + JSON.stringify({ session_id: ID, ...FRIEND }) + '\n说明';
  writeFileSync(file, JSON.stringify({ type: 'user', message: { content: marker } }) + '\n');
  assert.equal(runtime.inheritedChoice(file), null);
  writeFileSync(file, JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [marker] } }) + '\n');
  const out = runtime.resolveState(root, { session_id: OTHER, transcript_path: file });
  assert.equal(out.origin, 'inherited');
  assert.equal(out.persona, FRIEND.persona);
  assert.throws(() => runtime.selectState(root, OTHER, { mode: 'counseling' }), /永久锁定/);
});

test('已有原咨询上下文的旧窗口锁为咨询，不转成朋友', t => {
  const root = fixture(t), file = join(root, 'synthetic.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files: [{ content: '# Sage\n## 会谈启动流程\n原始咨询内容' }] } }) + '\n');
  const state = runtime.resolveState(root, { session_id: ID, transcript_path: file });
  assert.equal(state.mode, 'counseling');
  assert.equal(state.origin, 'legacy-counseling');
});

test('读取兜底隔离咨询人格与朋友配置，同时允许朋友参考全部咨询笔记', () => {
  const read = file_path => ({ tool_name: 'Read', tool_input: { file_path } });
  for (const file of ['.therapy/persona.md', '.therapy/modalities/cbt.md', '.therapy/library/personas/direct-challenging.md', '.therapy/modes/counseling.md']) assert.ok(runtime.deniedTool('unused', read(file), FRIEND));
  assert.equal(runtime.deniedTool('unused', read('sessions/2026-10-20.md'), FRIEND), null);
  assert.equal(runtime.deniedTool('unused', read('profile.md'), FRIEND), null);
  assert.ok(runtime.deniedTool('unused', read('.therapy/friend-lengths/deep.md'), { mode: 'counseling' }));
  assert.equal(runtime.deniedTool('unused', read('.therapy/modalities/cbt.md'), { mode: 'counseling' }), null);
});

test('工具不能直接改状态或咨询资产；合法的设置工具由排他写入规则校验', () => {
  assert.ok(runtime.deniedTool('unused', { tool_name: 'Write', tool_input: { file_path: '.therapy/conversations/' + ID + '.json' } }, FRIEND));
  assert.ok(runtime.deniedTool('unused', { tool_name: 'Edit', tool_input: { file_path: '.therapy/persona.md' } }, { mode: 'counseling' }));
  assert.equal(runtime.deniedTool('unused', { tool_name: 'Bash', tool_input: { command: 'node .therapy/hooks/session-mode.cjs --select' } }, null), null);
});

test('PreToolUse 给出明确拒绝，缺少 ID 不伪造选择', t => {
  const root = fixture(t);
  runtime.selectState(root, ID, FRIEND);
  const out = runtime.runHook({ session_id: ID, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.therapy/persona.md' } }, root);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.throws(() => runtime.runHook({ hook_event_name: 'SessionStart' }, root), /会话 ID/);
});

// 锁定指选项及其实际正文，不能借编辑文件改变当前朋友人格或篇幅。
test('朋友人格和篇幅正文不能在对话中改写，全目录搜索需限定背景', () => {
  for (const file of ['.therapy/friend-personas/light-humor.md', '.therapy/friend-lengths/deep.md']) assert.ok(runtime.deniedTool('unused', { tool_name: 'Edit', tool_input: { file_path: file } }, FRIEND));
  assert.ok(runtime.deniedTool('unused', { tool_name: 'Grep', tool_input: { pattern: '.*' } }, FRIEND));
  assert.equal(runtime.deniedTool('unused', { tool_name: 'Grep', tool_input: { path: 'sessions', pattern: '合成话题' } }, FRIEND), null);
});
