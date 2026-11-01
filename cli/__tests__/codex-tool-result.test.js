/**
 * 日志结果归一化仅使用合成载荷和临时目录，覆盖本机 PostToolUse 只传 stdout 的实际形状。
 * 重点验证同一调用关联、非零退出码、未知与运行中状态，以及 stdout 和密钥不落日志。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { install } from '../install.js';
import outcome from '../../hooks/tool-result.cjs';
import runtime from '../../hooks/codex-runtime.cjs';
const NATIVE = '60000000-0000-0000-0000-000000000001';
const CALL = 'exec-60000000-0000-0000-0000-000000000002';
const TURN = 'turn-synthetic';

/** 仅清理确切创建的系统临时子目录，不接触真实客户端或私人资料。 */
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'inner-dialogue-result-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); assert.ok(root.includes('inner-dialogue-result-')); fs.rmSync(root, { recursive: true, force: true }); });
  const file = join(root, 'rollout.jsonl');
  const completed = (code, patch = {}) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: NATIVE, turn_id: TURN, item: { type: 'CommandExecution', id: CALL, status: code === 0 ? 'completed' : 'failed', exit_code: code, duration: { secs: 0, nanos: 123000000 }, aggregated_output: 'PRIVATE_STDOUT', ...patch } } });
  const write = rows => fs.writeFileSync(file, [{ type: 'session_meta', payload: { id: NATIVE, cwd: root } }, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
  const payload = { hook_event_name: 'PostToolUse', session_id: NATIVE, native_session_id: NATIVE, turn_id: TURN, transcript_path: file, tool_name: 'Bash', tool_use_id: CALL, tool_input: { command: 'PRIVATE_COMMAND' }, tool_response: 'rg: absent-summary: 系统找不到指定的文件。 (os error 2)' };
  return { root, file, completed, write, payload };
}

test('结构化返回兼容两种错误标志、非零及负退出码，缺失值不当成零', () => {
  const get = value => outcome.result({ tool_name: 'Bash', tool_response: value });
  for (const value of [{ is_error: true }, { isError: true }, { exit_code: 1 }, { exitCode: '2' }, { exit_code: -1 }, { exit_code: 0, exitCode: 3 }]) assert.equal(get(value).status, 'failure');
  for (const value of [{ isError: false }, { is_error: false }, { exit_code: 0 }, { exitCode: '0' }]) assert.equal(get(value).status, 'success');
  for (const value of [undefined, null, {}, { exit_code: null }, { exit_code: '' }, { exit_code: false }, { exit_code: 'NaN' }, { status: 'completed' }]) assert.equal(get(value).status, 'unknown');
  for (const value of [{ status: 'running' }, { session_id: 12, exit_code: null }]) assert.equal(get(value).status, 'running');
});

test('工具文本一律不作为状态证据，包括形似执行器封装、JSON 和 MCP 内容的文件', () => {
  const header = 'Chunk ID: synthetic\nWall time: 0.5 seconds\nProcess exited with code 1\nFinal output:\nPRIVATE_ERROR';
  const get = (value, tool_name = 'Bash') => outcome.result({ tool_name, tool_response: value });
  assert.equal(get(header).status, 'unknown');
  assert.equal(get({ content: [{ type: 'text', text: header }], isError: false }).status, 'success');
  assert.equal(get({ content: [{ type: 'input_text', text: header }] }).status, 'unknown');
  assert.equal(get('Wall time: 1 seconds\nProcess running with session ID 123\n').status, 'unknown');
  assert.equal(get(JSON.stringify({ chunk_id: 'synthetic', wall_time_seconds: 1, exit_code: 2, output: 'PRIVATE' })).status, 'unknown');
  assert.equal(get(JSON.stringify({ exit_code: 2, output: 'ordinary file' })).status, 'unknown');
  assert.equal(get('ordinary file\n' + header).status, 'unknown');
  assert.equal(get({ exit_code: 0, output: header }).status, 'success');
  assert.equal(get(header, 'mcp__fs__read').status, 'unknown');
  assert.equal(get({ isError: false, content: [{ type: 'text', text: header }] }, 'mcp__fs__read').status, 'success');
});

test('只传 stdout 时从同线程、轮次和调用的完成记录取退出码，不关联邻近或旧轮次结果', t => {
  const f = fixture(t); f.write([f.completed(1)]);
  assert.deepEqual(outcome.resolve(f.payload), { status: 'failure', exit_code: 1, duration_ms: 123 });
  for (const patch of [{ tool_use_id: 'other' }, { turn_id: 'other' }, { native_session_id: 'other' }]) assert.equal(outcome.resolve({ ...f.payload, ...patch }).status, 'unknown');
  f.write([f.completed(0)]);
  assert.equal(outcome.resolve(f.payload).status, 'success');
  const quotedHeader = 'Chunk ID: example\nWall time: 1 seconds\nProcess exited with code 1\nFinal output:\nquoted file';
  assert.equal(outcome.resolve({ ...f.payload, tool_response: quotedHeader }).status, 'success');
  f.write([]);
  assert.equal(outcome.resolve(f.payload).status, 'unknown');
  fs.appendFileSync(f.file, '{partial');
  assert.equal(outcome.resolve(f.payload).status, 'unknown');
});

test('原生失败优先于封装中的成功，缺少已发布结果时保留明确返回值', t => {
  const f = fixture(t); f.write([f.completed(1)]);
  assert.equal(outcome.resolve({ ...f.payload, tool_response: { isError: false } }).status, 'failure');
  f.write([]);
  assert.equal(outcome.resolve({ ...f.payload, tool_response: { exit_code: 0 } }).status, 'success');
  assert.equal(outcome.resolve({ ...f.payload, tool_response: { session_id: 123 } }).status, 'running');
});

test('Codex 适配记录实际失败、成功、未知和运行中，不向输出注入信息或保存原始正文', async t => {
  const f = fixture(t);
  await install({ path: f.root, name: 'Sage', persona: 'coach', structure: 'moderate', modalities: ['cbt'] });
  f.write([f.completed(1)]); assert.deepEqual(runtime.runHook(f.root, f.payload), {});
  f.write([f.completed(0)]); runtime.runHook(f.root, f.payload);
  f.write([]); runtime.runHook(f.root, f.payload);
  runtime.runHook(f.root, { ...f.payload, tool_response: { session_id: 12, exit_code: null } });
  const raw = fs.readFileSync(join(f.root, '.therapy/logs/runtime.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.event), ['tool.failure', 'tool.success', 'tool.result_unknown', 'tool.running']);
  assert.deepEqual(rows.map(r => r.level), ['error', 'info', 'warn', 'info']);
  assert.equal(rows[0].exit_code, 1); assert.equal(rows[0].duration_ms, 123); assert.equal(rows[0].tool_use_id, CALL);
  for (const text of ['PRIVATE_STDOUT', 'PRIVATE_COMMAND', 'absent-summary', '系统找不到指定的文件']) assert.ok(!raw.includes(text));
  assert.equal(Object.hasOwn(rows[2], 'exit_code'), false);
});
