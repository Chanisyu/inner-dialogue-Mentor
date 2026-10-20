# 入门指南

本指南适用于当前这份简体中文项目。若通过上游英文仓库或 `npx inner-dialogue@latest` 安装，得到的内容未必是这里的中文版。

## 1. 准备环境

安装 Node.js 18.3 或更新版本，并准备能够在指定目录中读写文件的 Claude Code 环境。模型账户、订阅或 API 费用由你实际连接的服务商决定，本项目不包含模型服务。

在终端确认：

```powershell
node --version
claude --version
```

安全辅助钩子的注册格式要求 Claude Code `2.1.139` 或更新版本；不支持钩子的环境仍可读取文本模板，但机械安全提醒和使用统计不会自动运行。

## 2. 创建中文咨询目录

打开本项目根目录，可直接运行交互式安装：

```powershell
node bin/inner-dialogue.js install
```

安装会询问名称、保存位置、人格、结构和疗法。也可以通过参数指定：

```powershell
node bin/inner-dialogue.js install --name 柳 --path D:/Therapy/Willow --persona warm-4o --structure moderate --modalities cbt,ifs
```

这里的路径只是示例，请使用你自己的新目录。名称可以是中文；命令中的人格和疗法使用固定英文标识。

另一种方式是在本项目根目录启动 Claude，让根目录 `CLAUDE.md` 引导设置。引导流程会说明 AI 的能力与限制，询问你的偏好，展示选项并运行本地安装器。它不会自行替你决定个人经历或临床结论。

### 人格选项

`warm-4o`（温暖自然）、`warm-supportive`（温暖支持）、`direct-challenging`（直接挑战）、`coach`（行动教练）、`grounded-real`（务实真诚）、`contemplative`（沉思留白）、`philosophical`（哲学与存在探索）、`creative`（创意探索）。

人格只控制交流风格。若希望更充分的共情、分析和详细计划，请在会谈中具体说明；默认的简短交流习惯仍保留原项目设定。

### 结构选项

`structured`（明确结构）、`moderate`（适度结构）、`freeform`（自由展开）。

### 疗法选项

`cbt`、`act`、`cft`、`dbt-skills`、`ifs`、`lifespan-integration`、`motivational-interviewing`、`narrative`、`polyvagal`、`psychodynamic`、`sfbt`、`somatic-experiencing`、`ideal-parent-figure`。中文名称与作用见 [README](../README.md)。

## 3. 开始第一次会谈

在 Claude 应用中打开新生成的咨询目录，或进入该目录运行：

```powershell
claude
```

注意选择咨询目录，而不是安装源码目录。咨询目录里应能看到 `CLAUDE.md`、`profile.md`、`sessions/`、`context/` 与隐藏的 `.therapy/`。

你可以自然地介绍自己、说明想谈什么，也可以明确提出希望的表达方式，例如：“先帮我梳理目前的情况，再说明可能的理解依据，最后一起讨论可行的下一步。”信息不足时，模型应通过交流了解情况，而不是过早给出确定结论。

会谈开始时的文件读取、结束时的记录由提示词引导模型执行，并非独立数据库保证。可以查看实际生成的笔记，确认是否准确；有误时直接要求更正。

## 4. 导入已有记录

向咨询师提出导入请求，并提供你希望使用的资料位置。可以是既有会谈笔记、聊天导出、日记或现实专业人员的记录。模型会检查资料、讨论如何处理，并转换为项目中的记录形式。

导入应保留来源与日期；不确定的日期不能编造。现实治疗记录中的 `therapist:` 字段用于标记真实专业来源，不应用于 AI 自己写的会谈笔记。

若已有历史笔记但背景资料库为空，咨询师可以征求是否从历史中提炼人物、主题或事件。候选条目先由你确认，再以 `Provisional` 标记写入；你拒绝后不应反复询问。也可直接说“建立我的背景资料库”。

## 5. 查看和调整

所有记录都是 Markdown 文件，可用普通编辑器查看，也可以用你习惯的 Markdown 笔记工具打开。`profile.md` 记录你本人，`sessions/` 记录按时间发生的会谈，`context/` 整理反复出现的人物和主题。

要调整风格，直接说“更换人格”“调整结构”或“添加 ACT”。具体命令见 [commands.md](../commands.md)。既有档案中的当前状态可通过“复核我的档案”逐项确认，不会凭空补日期。

## 6. 检查安装

从中文项目根目录运行：

```powershell
node bin/inner-dialogue.js doctor --path D:/Therapy/Willow
```

`doctor` 检查必要文件、登记信息、中文或英文档案标题、钩子配置等。能运行 Claude Code 时，它还会测试安全钩子实际执行情况，测试消息会在发送给模型前被拦截。结构检查通过只表示安装条件满足，不代表模型的咨询质量已经验证。

## 7. 更新与迁移

先预览，再按需要应用：

```powershell
node bin/inner-dialogue.js update --path D:/Therapy/Willow --dry-run
node bin/inner-dialogue.js update --path D:/Therapy/Willow
```

更新会保留个人档案、会谈与背景资料；已修改的框架文件默认跳过。`--force` 会覆盖相应框架修改，先读计划并保留备份。

普通更新不会重写既有 `CLAUDE.md`，也不会整体替换已有 `.claude/settings.json`。需要将旧英文根指令换成中文时，请按[迁移指南](../MIGRATING.md)处理。

咨询目录可以独立保存与使用，但本地中文更新仍需要这份来源项目。新安装会在 `.therapy/version.json` 的 `source_path` 中记录来源位置。移动来源项目后应修正路径；不要直接改用上游下载命令，否则可能切回英文。

## 隐私与备份

文件保存在本地；云端模型仍会处理发送给它的内容。代理服务也可能位于数据链路中。请检查实际提供商政策、云盘同步和操作系统备份；加密方案见 [SECURITY.md](../SECURITY.md)。

备份咨询目录可以保留档案、会谈和背景；备份本地中文项目可以保留这份模板与更新来源。不要把真实个人资料作为项目测试夹具或提交到公开仓库。
