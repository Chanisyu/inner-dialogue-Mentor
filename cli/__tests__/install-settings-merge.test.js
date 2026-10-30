// Tests for the settings merge in `install` (F21). When install runs over a
// folder that already has .claude/settings.json (the documented --force
// migration path, or a pre-created project folder), it must apply the same
// append-if-absent merge `update` uses — backup first, never clobber —
// instead of leaving the hook script installed but unregistered.
//
// Same black-box precedent as update-settings-merge.test.js: fixtures are
// built by spawning the real CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', '..', 'bin', 'inner-dialogue.js');

const INSTALL_ARGS = (root) => [
  'install',
  '--name', 'Sage',
  '--path', root,
  '--persona', 'warm-4o',
  '--structure', 'moderate',
  '--modalities', 'cbt',
];

// A pre-safety-net settings file: the shipped time hook plus an unrelated
// user customization. Both must survive the merge untouched.
const TIME_HOOK_SETTINGS = {
  customKey: { keep: 'me' },
  hooks: {
    UserPromptSubmit: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'date "+%A %Y-%m-%d %H:%M"' }],
      },
    ],
  },
};

// A settings file that already carries BOTH UserPromptSubmit hooks (the time
// hook and the safety-net hook) but no SessionStart hook. Used to isolate the
// usage-stats SessionStart merge: only that hook should be added, and the two
// existing UserPromptSubmit hooks must be left untouched.
const TWO_UPS_HOOKS_SETTINGS = {
  customKey: { keep: 'me' },
  hooks: {
    UserPromptSubmit: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'date "+%A %Y-%m-%d %H:%M"' }],
      },
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: 'node',
            args: ['${CLAUDE_PROJECT_DIR}/.therapy/hooks/safety-net.js'],
          },
        ],
      },
    ],
  },
};

function runJson(args, label) {
  const result = spawnSync('node', [CLI_PATH, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    assert.fail(
      `stdout is not JSON for ${label}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
  return { status: result.status, stderr: result.stderr, json };
}

function freshInstall() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'id-install-merge-'));
  const root = path.join(dir, 'Sage');
  const res = runJson(INSTALL_ARGS(root), 'install');
  assert.equal(res.json.ok, true, `install ok (stderr: ${res.stderr})`);
  return {
    dir,
    root,
    settingsPath: path.join(root, '.claude', 'settings.json'),
  };
}

function settingsBackups(root) {
  return readdirSync(path.join(root, '.claude')).filter((n) =>
    n.startsWith('settings.json.bak-')
  );
}

function safetyNetEntries(settings) {
  return (settings.hooks?.UserPromptSubmit || []).filter((entry) =>
    (entry.hooks || []).some(
      (h) =>
        (typeof h.command === 'string' && h.command.includes('safety-net.js')) ||
        (Array.isArray(h.args) &&
          h.args.some((a) => typeof a === 'string' && a.includes('safety-net.js')))
    )
  );
}

function usageStatsEntries(settings) {
  return (settings.hooks?.SessionStart || []).filter((entry) =>
    (entry.hooks || []).some(
      (h) =>
        (typeof h.command === 'string' && h.command.includes('usage-stats.js')) ||
        (Array.isArray(h.args) &&
          h.args.some((a) => typeof a === 'string' && a.includes('usage-stats.js')))
    )
  );
}

test('install --force over existing settings appends the hook entry, backup first', () => {
  const { dir, root, settingsPath } = freshInstall();
  try {
    writeFileSync(
      settingsPath,
      JSON.stringify(TIME_HOOK_SETTINGS, null, 2) + '\n'
    );

    const res = runJson(
      [...INSTALL_ARGS(root), '--force'],
      'install --force merge'
    );
    assert.equal(res.status, 0, `exit 0 (stderr: ${res.stderr})`);
    assert.equal(res.json.ok, true);

    // Install now merges BOTH hooks into a pre-existing settings file: the
    // safety-net hook (UserPromptSubmit) and the usage-stats hook
    // (SessionStart). Assert the merge SET rather than a single item.
    const merges = res.json.settings_merge;
    assert.ok(Array.isArray(merges), 'result.settings_merge is an array');
    assert.equal(merges.length, 3, '安全、使用统计与运行日志三组合并');
    for (const m of merges) {
      assert.equal(m.path, '.claude/settings.json');
      assert.ok(
        m.backup.includes('settings.json.bak-'),
        'merge item reports its backup path'
      );
    }
    assert.deepEqual(
      merges.map((m) => m.action).sort(),
      ['add_runtime_log_hooks', 'add_safety_net_hook', 'add_usage_stats_hook'],
      'the merge set adds the safety-net (UserPromptSubmit) and usage-stats (SessionStart) hooks'
    );

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(
      settings.customKey,
      { keep: 'me' },
      'unrelated custom key preserved'
    );
    assert.equal(
      settings.hooks.UserPromptSubmit.length,
      4,
      'appended, not replaced'
    );
    assert.equal(safetyNetEntries(settings).length, 1, 'one safety-net entry');
    assert.equal(
      usageStatsEntries(settings).length,
      1,
      'one usage-stats SessionStart entry'
    );

    const baks = settingsBackups(root);
    // 两次合并可能落在同一秒，也可能跨秒；验证实际返回的备份集合，
    // 不用机器速度或时间边界决定测试成败。每份都必须保留无关配置，
    // 并发生在使用统计钩子写入前；不改变原有备份实现。
    const expectedBackups = [...new Set([...merges.map(m => m.backup), res.json.archiving.backup].filter(Boolean).map(file => path.basename(file)))].sort();
    assert.deepEqual(baks.sort(), expectedBackups, 'every reported backup exists, with no extra backup');
    for (const filename of baks) {
      const bak = JSON.parse(readFileSync(path.join(root, '.claude', filename), 'utf8'));
      assert.deepEqual(bak.customKey, { keep: 'me' }, 'backup holds a pre-merge snapshot');
      // 日志注册备份发生在原有两钩子注册之后；其他备份仍须早于使用统计注册。
      if (filename.startsWith('settings.json.bak-archive-')) assert.ok(!JSON.stringify(bak).includes('transcript-archive.cjs'));
      else if (filename.startsWith('settings.json.bak-runtime-log-')) assert.ok(!JSON.stringify(bak).includes('runtime-log.cjs'));
      else assert.ok(!bak.hooks.SessionStart, 'backup predates the usage-stats registration');
    }

    // No stray temp files from the atomic write
    const leftovers = readdirSync(path.join(root, '.claude')).filter(
      (n) => n !== 'settings.json' && !n.startsWith('settings.json.bak-')
    );
    assert.deepEqual(leftovers, [], 'no stray temp files left in .claude/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('second install --force is idempotent: no duplicate entry, no new backup', () => {
  const { dir, root, settingsPath } = freshInstall();
  try {
    writeFileSync(
      settingsPath,
      JSON.stringify(TIME_HOOK_SETTINGS, null, 2) + '\n'
    );
    const first = runJson([...INSTALL_ARGS(root), '--force'], 'first force');
    assert.equal(first.json.ok, true);
    assert.equal(first.json.settings_merge.length, 3, '三组钩子均已合并');
    const firstBackups = settingsBackups(root).sort();

    const second = runJson([...INSTALL_ARGS(root), '--force'], 'second force');
    assert.equal(second.status, 0);
    assert.equal(second.json.ok, true);
    assert.deepEqual(
      second.json.settings_merge,
      [],
      'second run reports no merge'
    );

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(
      safetyNetEntries(settings).length,
      1,
      'exactly one safety-net entry'
    );
    assert.equal(
      usageStatsEntries(settings).length,
      1,
      'exactly one usage-stats entry'
    );
    assert.deepEqual(settingsBackups(root).sort(), firstBackups, '第二次安装没有新增备份');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install --force with malformed settings skips with a reason, file untouched', () => {
  const { dir, root, settingsPath } = freshInstall();
  try {
    const garbage = '{ this is not json';
    writeFileSync(settingsPath, garbage);

    const res = runJson(
      [...INSTALL_ARGS(root), '--force'],
      'install --force malformed'
    );
    assert.equal(res.status, 0, `exit code unchanged (stderr: ${res.stderr})`);
    assert.equal(res.json.ok, true);

    // Both merges (safety-net + usage-stats) skip on malformed JSON.
    const merges = res.json.settings_merge;
    assert.equal(merges.length, 3, '损坏设置使三组合并均跳过');
    for (const m of merges) {
      assert.equal(m.action, 'skipped');
      assert.ok(m.reason, 'skip carries a reason');
    }

    assert.equal(
      readFileSync(settingsPath, 'utf8'),
      garbage,
      'malformed file left byte-for-byte untouched'
    );
    assert.equal(settingsBackups(root).length, 0, 'no backup created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// F33: an fs failure inside the merge apply (read-only .claude/ makes the
// pre-merge backup copy fail) must downgrade to a skipped item — the rest of
// the install, including version.json, still completes.
test(
  'install --force with fs failure during merge skips with the error, install completes',
  { skip: process.platform === 'win32' },
  () => {
    const { dir, root, settingsPath } = freshInstall();
    const claudeDir = path.join(root, '.claude');
    try {
      const before = JSON.stringify(TIME_HOOK_SETTINGS, null, 2) + '\n';
      writeFileSync(settingsPath, before);
      chmodSync(claudeDir, 0o555); // read-only: backup + temp write both fail

      const res = runJson(
        [...INSTALL_ARGS(root), '--force'],
        'install --force read-only'
      );
      chmodSync(claudeDir, 0o755);

      assert.equal(res.status, 0, `exit 0 (stderr: ${res.stderr})`);
      assert.equal(res.json.ok, true, 'install completes despite the fs failure');

      // Both merges downgrade to a skip carrying the fs error.
      const merges = res.json.settings_merge;
      assert.equal(merges.length, 3, '文件系统失败使三组合并均跳过');
      for (const m of merges) {
        assert.equal(m.action, 'skipped');
        assert.ok(
          m.reason.includes('settings merge failed'),
          `skip reason carries the error: ${m.reason}`
        );
      }

      assert.equal(
        readFileSync(settingsPath, 'utf8'),
        before,
        'settings.json left untouched'
      );
      assert.equal(settingsBackups(root).length, 0, 'no backup created');
    } finally {
      chmodSync(claudeDir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test('fresh install scaffolds the template with the hook already registered (no merge)', () => {
  const { dir, root, settingsPath } = freshInstall();
  try {
    // freshInstall already ran plain install into an empty folder
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(
      safetyNetEntries(settings).length,
      1,
      'template scaffold carries the safety-net entry'
    );
    assert.equal(settingsBackups(root).length, 0, 'no backup on scaffold');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T-203/T-302: with the safety-net hook already registered under
// UserPromptSubmit, install --force merges ONLY the usage-stats SessionStart
// hook — and leaves the two pre-existing UserPromptSubmit hooks alone.
test('install --force registers the SessionStart usage-stats hook without disturbing the UserPromptSubmit hooks', () => {
  const { dir, root, settingsPath } = freshInstall();
  try {
    writeFileSync(
      settingsPath,
      JSON.stringify(TWO_UPS_HOOKS_SETTINGS, null, 2) + '\n'
    );

    const res = runJson(
      [...INSTALL_ARGS(root), '--force'],
      'install --force sessionstart'
    );
    assert.equal(res.status, 0, `exit 0 (stderr: ${res.stderr})`);
    assert.equal(res.json.ok, true);

    // The safety-net hook is already present, so only the usage-stats hook is
    // added.
    assert.deepEqual(
      res.json.settings_merge.map((m) => m.action),
      ['add_usage_stats_hook', 'add_runtime_log_hooks'],
      'only the SessionStart usage-stats hook is merged'
    );

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

    // A SessionStart group is created with the canonical matcher and a command
    // referencing usage-stats.js.
    const sessionStart = settings.hooks.SessionStart;
    assert.ok(
      Array.isArray(sessionStart) && sessionStart.length === 3,
      'SessionStart group created'
    );
    assert.equal(
      sessionStart[0].matcher,
      'startup|resume|clear|compact',
      'SessionStart matcher'
    );
    const cmdHook = sessionStart[0].hooks[0];
    const referencesScript =
      (typeof cmdHook.command === 'string' &&
        cmdHook.command.includes('usage-stats.js')) ||
      (Array.isArray(cmdHook.args) &&
        cmdHook.args.some(
          (a) => typeof a === 'string' && a.includes('usage-stats.js')
        ));
    assert.ok(referencesScript, 'SessionStart command references usage-stats.js');

    // The two pre-existing UserPromptSubmit hooks are untouched.
    assert.equal(
      settings.hooks.UserPromptSubmit.length,
      4,
      '保留两个原有钩子，并追加一个运行日志观察钩子'
    );
    assert.equal(
      settings.hooks.UserPromptSubmit[0].hooks[0].command,
      'date "+%A %Y-%m-%d %H:%M"',
      'the pre-existing time hook is preserved in place'
    );
    assert.equal(
      safetyNetEntries(settings).length,
      1,
      'the pre-existing safety-net hook is preserved, not duplicated'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('second install --force does not double-register the SessionStart usage-stats hook', () => {
  const { dir, root, settingsPath } = freshInstall();
  try {
    writeFileSync(
      settingsPath,
      JSON.stringify(TWO_UPS_HOOKS_SETTINGS, null, 2) + '\n'
    );
    const first = runJson([...INSTALL_ARGS(root), '--force'], 'first force');
    assert.deepEqual(
      first.json.settings_merge.map((m) => m.action),
      ['add_usage_stats_hook', 'add_runtime_log_hooks'],
      'first run merges the usage-stats hook'
    );

    const second = runJson([...INSTALL_ARGS(root), '--force'], 'second force');
    assert.equal(second.status, 0);
    assert.equal(second.json.ok, true);
    assert.deepEqual(
      second.json.settings_merge,
      [],
      'second run reports no merge'
    );

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(
      usageStatsEntries(settings).length,
      1,
      'exactly one SessionStart usage-stats entry'
    );
    assert.equal(
      settings.hooks.UserPromptSubmit.length,
      4,
      '两个原有钩子和一个日志观察钩子均未重复注册'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
