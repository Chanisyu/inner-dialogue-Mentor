# 统一运行日志

日志用于排查程序运行问题，不作为咨询记忆，也不会自动注入模型上下文。默认位置为咨询目录的 `.therapy/logs/runtime.jsonl`。每行是一个独立 JSON 记录，包含实际时间、级别、模块、操作、可用的会话 ID，以及工具名称、项目内相对文件位置或固定错误分类等元数据。

## 记录范围

- 会话开始、恢复、提交消息和结束事件。
- 文件与其他工具开始执行、成功或失败；读取失败可记录为 `ENOENT` 等固定原因。
- 双模式选择、规则拦截及配置或状态错误。被模式钩子拒绝的操作在该模块单独记录，因为执行前的拒绝不一定产生工具失败事件。
- 安装、更新、检查和双模式管理命令的结果，以及设置合并跳过。首次安装尚无有效目录时，CLI 故障可写到用户目录的 `.inner-dialogue/logs/runtime.jsonl`；正常成功安装后使用咨询目录日志。

严格预览 `--dry-run` 和状态查询 `--status` 完全不写日志，保持其只读含义。

## 字段与事件对照

| 字段 | 含义与保存条件 |
| --- | --- |
| `schema`、`timestamp`、`pid` | 日志格式版本、记录时的 UTC 时间、写入进程编号 |
| `level`、`component`、`event` | 严重程度、产生记录的模块、操作名称 |
| `session_id` | 输入中存在符合格式的会话标识时保存，用于关联同一次交流 |
| `hook_event`、`tool_name`、`tool_use_id` | 输入符合白名单时保存的钩子、工具与工具调用标识 |
| `file` | 项目内相对路径；项目外路径仅记录为 `[outside-project]` |
| `command`、`mode` | 白名单中的 CLI 子命令或对话模式，不是完整命令行 |
| `duration_ms`、`exit_code` | 调用方明确提供有效数值时保存；不根据缺失值推测 |
| `error.code`、`error.message` | 固定错误分类与对应说明，不是原始异常或工具输出 |

观察事件对应 `session.start`、`prompt.submitted`、`tool.start`、`tool.success`、`tool.failure`、`session.end`。模式模块另写 `mode.selected`、`tool.denied`、`mode.failure`；CLI 写 `command.complete`、`command.failure`、`settings.merge_skipped`。

同一操作可能有一条观察记录和一条模式拦截记录，这是不同阶段的诊断证据，不应直接按日志行数统计会谈或故障次数。当前观察器未从 shell 错误正文提取退出码，因此不能假定每条失败事件均含 `exit_code`。

## 隐私与容量

不保存聊天正文、档案内容、工具输入输出正文、shell 命令、搜索词、凭据、原始异常文字或堆栈。错误文字仅用于转换为固定分类；外部文件路径只标为项目外，不保存其个人绝对路径。

每个文件达到约 2 MiB 后轮转，保留 `runtime.jsonl.1`、`.2`、`.3`。较旧记录会被淘汰，因此日志不是永久归档。日志本身没有额外加密；同一系统账户仍可能读取会话时间和文件路径等元数据。

## 启用与升级

新安装默认带日志模块和观察钩子。已有普通或双模式目录，从本地中文项目执行：

```powershell
node bin/inner-dialogue.js update --path "D:\Project\Person\Sage" --dry-run
node bin/inner-dialogue.js update --path "D:\Project\Person\Sage"
```

更新保留既有钩子；双模式只添加独立日志模块并更新模式辅助脚本，不修改已冻结的咨询正文、安全脚本、使用统计脚本及个人资料。重新打开对话，使客户端加载新的钩子设置。

`doctor` 在模块已安装时检查观察事件注册是否完整。它不保证客户端已执行钩子，也不代表历史错误都被收集。

## 查看

```powershell
Get-Content -LiteralPath "D:\Project\Person\Sage\.therapy\logs\runtime.jsonl" -Tail 30
```

筛选当前文件中的警告或错误：

```powershell
Get-Content -LiteralPath "D:\Project\Person\Sage\.therapy\logs\runtime.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.level -in @('warn', 'error') }
```

需要较早记录时，同时查看轮转文件。`session_id` 用于关联同一次交流的事件；日志不会保存该次交流的正文。

## 仍然存在的边界

记录依赖客户端执行钩子。未执行钩子、进程突然被终止、磁盘不可写，以及原安全或使用统计组件内部已静默处理的异常，都可能没有对应记录。日志失败不会中断会谈。

模型没有发起必要的文件读取、不准确地声称已保存、对话质量或理解错误，不一定产生程序异常，不能仅靠本日志自动发现。网络与模型提供商内部的问题也只有在客户端报告相应事件时才能被记录。原客户端会话日志仍可用于补充排查。

事件输入按照 Claude Code 的官方钩子说明处理：<https://code.claude.com/docs/en/hooks>。观察器不返回拦截决定，也不添加聊天上下文。

## 已有验证记录

2026-10-30 的日志功能实现提交 `22ff9cd` 已执行以下检查：主测试 233 项，226 通过、7 项平台跳过；评测工具测试 204 项，203 通过、1 项平台跳过；中文安全检查 31/31 通过，均无失败。打包预览确认包含日志模块、注册辅助模块和说明文档，没有包含个人运行日志。

本地安装核对确认 Sage 的咨询正文及个人资料保持原字节，并成功写入更新结果和日志就绪验证记录。这些结果证明所测实现与部署行为，不表示所有客户端故障都可捕获，也不代表真实模型每轮已执行全部钩子。
