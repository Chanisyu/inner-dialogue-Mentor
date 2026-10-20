# 迁移与更新指南

本指南适用于当前本地中文项目。更新来源应是这份项目，而不是上游英文 npm 包。

## 先检查计划

在本项目根目录运行：

```powershell
node bin/inner-dialogue.js doctor --path D:/Therapy/Willow
node bin/inner-dialogue.js update --path D:/Therapy/Willow --dry-run
```

请替换示例路径。`--dry-run` 只显示计划，不写入。不要将源码目录误当作咨询目录。

## 正常更新

```powershell
node bin/inner-dialogue.js update --path D:/Therapy/Willow
```

安装记录中的哈希用来识别框架文件是否被改过：

| 文件或情况 | 默认处理 |
| --- | --- |
| 已登记且与登记哈希一致的框架文件 | 随当前来源更新 |
| 新增框架组件 | 安装到相应位置 |
| 已登记且未修改的当前人格、结构、疗法 | 可以更新 |
| 自行修改或来源无法确定的框架文件 | 跳过并说明原因 |
| `profile.md`、`sessions/`、`context/` 中的个人内容 | 保留 |
| 现有根目录 `CLAUDE.md` | 普通更新始终保留 |
| 现有 `.claude/settings.json` | 不整体覆盖；必要时仅合并缺失的框架钩子 |
| 缺失的背景索引、目录或初始设置 | 按模板补建 |

写入前会生成 `.therapy.bak-时间戳` 备份。钩子合并也会先备份设置文件，并使用原子写入；JSON 语法有误时保留原文件，提示手工修复。

## 用户改动与未知来源

旧版登记信息可能缺少文件哈希。程序不会假设这些文件可以安全覆盖：已经与当前来源一致的文件可以登记，其余显示为未知来源或用户修改。

先比较现有文件与项目模板。如确实希望用当前中文框架替换这些改动，再使用：

```powershell
node bin/inner-dialogue.js update --path D:/Therapy/Willow --force --dry-run
node bin/inner-dialogue.js update --path D:/Therapy/Willow --force
```

`--force` 作用于框架文件，仍不会让普通更新重写根目录 `CLAUDE.md` 或个人记录。请检查 `forced_overwrites`、`skipped_user_edited` 和设置合并计划。

## 将旧英文启动指令换成中文

普通更新会提供中文组件，但保留原有 `CLAUDE.md`。因此，旧安装不一定会自动取得新版的启动读取、背景库复核或中文时间信号规则。

有两种方式：

1. **手工迁移。** 备份现有 `CLAUDE.md`，参考中文 `CLAUDE.template.md` 合并相关段落，保留原有的咨询师名称和你明确需要的自定义内容。模板中的占位符需替换，不能原样作为安装结果使用。
2. **原位重新安装。** 先备份咨询目录，明确指定原有名称、人格、结构和疗法，再运行安装命令。例如：

```powershell
node bin/inner-dialogue.js install --force --name 柳 --path D:/Therapy/Willow --persona warm-4o --structure moderate --modalities cbt,ifs
```

重新安装会按模板生成新的 `CLAUDE.md` 并刷新框架，因而可能覆盖你在这些文件里的自定义内容。安装器保留已有 `profile.md`、`sessions/` 和背景内容；已有设置不整体覆盖。不同于普通更新，这一步会重建启动指令，请先确认指定配置正确。

也可以建立全新的中文咨询目录，再通过会谈中的导入流程整理旧笔记。背景库从历史提炼条目时需经本人确认，并保留 `Provisional` 等来源标记。

## 很早的安装

旧版可能包含不再使用的启动脚本或旧元数据格式。更新计划会列出可识别的旧启动器移除和新登记项；真正的个人数据仍不应被当作框架更新目标。

若旧目录没有有效安装记录，请先备份并检查报错。可按上面的原位重新安装方式建立当前框架，或建立新目录后导入记录，不要凭文件名批量删除旧资料。

## 回退

备份包含更新前的框架状态。需要回退时先关闭正在使用该目录的会谈，保留当前目录的副本，再从相应 `.therapy.bak-时间戳` 复制所需文件；设置文件使用它自己的备份恢复。

恢复范围应与本次改动一致，不要用旧备份覆盖更新后产生的个人会谈笔记。可以用编辑器比较文件后逐项恢复；不要直接执行不加核对的递归删除命令。

## 保留中文更新来源

新安装或实际应用更新后，`.therapy/version.json` 会记录 `locale: "zh-CN"` 与 `source_path`。会谈中的更新命令使用这个来源路径调用本地 CLI。

移动项目后应同步调整来源路径，或从新位置明确运行上述命令。版本号不变但文件内容变化时，更新仍会依据内容哈希识别差异。此中文化没有自动发布到上游 npm。
