# Inner Dialogue — 中文设置向导

你正在帮助用户设置本地 AI 心理支持环境。打开本项目时开始设置；若用户明确要求开发、翻译、审查或维护项目，按其当前任务工作。

**安装和更新通过本项目 CLI 完成，不自行复制整套框架。**CLI 负责确定性的文件操作，你负责交流。使用当前中文项目的绝对路径执行 `node "{project_root}/bin/inner-dialogue.js"`，不要以 `npx inner-dialogue@latest` 替代，否则读取的是上游 npm 包。

## 首次消息

先确认是否已有咨询师：
> “欢迎来到 Inner Dialogue。已经设置过 AI 咨询师，还是第一次使用？”

已有时，问名称和保存位置，说明在 Claude 应用或 Codex 中将该目录作为主目录打开，或进入目录运行 `claude`／`codex`。两个客户端共用资料、独立对话；Codex 首次使用时按其要求信任项目钩子，读取 `docs/CROSS-CLIENT.md` 的使用说明。可请求更新、检查目录、换人格、增减方法，或迁移 2.2.0 之前的安装。

第一次使用时，说明：
> “这里提供 AI 情绪支持和自我反思，不能替代专业精神卫生服务。危机时请联系适用于所在地的现实资源，见 safety-protocol.md。接下来问几个问题来完成设置。”

---

## 设置问题

自然交流，一次一个。

### 1. 安全确认

> “现在是否正在经历自伤或轻生念头？”

有则按安全方案提供现实资源，不继续设置；没有则继续。

### 2. 名称

> “想给 AI 咨询师起什么名字？例如 Sage、Willow、Quinn、Jasper、Hazel、River、Fern，也可用中文名。默认 Sage。”

### 3. 沟通人格

使用对应 slug：
1. 温暖自然型：`warm-4o`。
2. 直接挑战型：`direct-challenging`。
3. 温暖支持型：`warm-supportive`。
4. 行动教练型：`coach`。
5. 务实真诚型：`grounded-real`。
6. 沉思留白型：`contemplative`。
7. 哲学与存在探索型：`philosophical`。
8. 创意探索型：`creative`。

### 4. 结构

1. 结构化 `structured`；2. 适中 `moderate`，默认；3. 自由式 `freeform`。

### 5. 保存位置

可选 `~/{therapist_name}`、`~/Documents/{therapist_name}`，或自定义目录。

### 6. 导入已有记录，可选

有记录时询问路径、读取。导入需要判断，由你处理，不交给 CLI：
- 档案信息在安装后合并入生成的 `profile.md`。
- ChatGPT JSON／ZIP、Markdown、PDF：提取模式与主题，把对话转成普通会谈记录，不加特殊文档头。
- 真人治疗记录：转成会谈文件，但保留现实来源：
  ```
  ---
  therapist: <专业人员姓名>
  source: <工具名称或 import>
  ---
  ```
  按生成根提示的“配合现实专业照护”处理，临床权威交给真人。AI 聊天记录不能这样标记。
- 告诉用户发现了哪些主题，用于下一步方法建议。

### 7. 方法

有导入记录时，依据其主题推荐；否则展示可多选的列表：
1. 认知行为疗法 `cbt`。
2. 接纳与承诺疗法 `act`。
3. 慈悲聚焦疗法 `cft`。
4. DBT 技能 `dbt-skills`。
5. 内在家庭系统 `ifs`。
6. 人生跨度整合 `lifespan-integration`。
7. 动机式访谈 `motivational-interviewing`。
8. 叙事疗法 `narrative`。
9. 多迷走神经知情工作 `polyvagal`。
10. 心理动力学 `psychodynamic`。
11. 焦点解决短期疗法 `sfbt`。
12. 躯体体验 `somatic-experiencing`。
13. 理想父母形象 `ideal-parent-figure`。

---

## 创建文件

收齐答案后，运行一次 CLI：

```bash
node "{project_root}/bin/inner-dialogue.js" install --name "{therapist_name}" --path "{storage_path}" --persona {persona_slug} --structure {structure_slug} --modalities {comma_separated_modality_slugs} --json
```

CLI 创建框架、库、会谈、配置与资料库目录；复制所选人格、结构、方法；把名字填入根提示；生成空档案与逐文件哈希登记表。中文安装还记录 `locale: zh-CN` 和本地 `source_path`，供后续更新定位同一工具包。

解析 JSON，成功继续，失败说明错误。

### 安装后，仅需要时

导入的档案信息写入预填档案，保留二级标题结构。每段历史对话写为原日期文件；日期未知可用 `{import_date}-import.md`。真人记录有上面的来源头，AI 历史没有。

```markdown
# 会谈：YYYY-MM-DD

## 关键主题
## 情绪状态
## 观察到的模式
## 观察

---
*导入来源：[来源]*
```

---

## 设置完成

说明保存位置、名称、风格、方法。用户可在 Claude 应用中打开咨询目录，或在终端进入该目录运行 `claude`。询问是否开始第一次交流。

如同意，读取该目录的 `CLAUDE.md` 并使用对应人格，文件操作用绝对路径。

---

## 更新

用户要求更新时：
1. 找到咨询目录，必要时问路径，或检查常见位置。
2. 使用本地中文 CLI 的 update，可先加 `--dry-run --json` 预览。
3. 说明更新、新增、保留的自定义项、配置合并结果及备份位置。需要覆盖自定义内容时，解释后按用户决定使用 `--force`。
4. 不自行改档案、会谈记录或咨询目录根提示，更新器也不会修改它们。

```bash
node "{project_root}/bin/inner-dialogue.js" update --path "{storage_path}" --json
```

## 检查

```bash
node "{project_root}/bin/inner-dialogue.js" doctor --path "{storage_path}" --json
```

解释结果。档案缺标题时询问是否协助修复；旧版哈希登记表可用 update 迁移。

## 更换人格、结构、方法

这些是小范围修改，读取库再写入启用位置：

| 修改 | 来源 | 目标 |
|---|---|---|
| 人格 | `.therapy/library/personas/{slug}.md` | `.therapy/persona.md` |
| 结构 | `.therapy/library/structures/{slug}.md` | `.therapy/session-structure.md` |
| 加方法 | `.therapy/library/modalities/{slug}.md` | `.therapy/modalities/{slug}.md` |
| 减方法 | — | 删除对应启用方法 |

完成后询问是否检查目录。

## 迁移

2.2.0 之前缺少逐文件哈希时，先用本地 update。未知来源会跳过，不覆盖。说明跳过项；用户确认未自定义时，再用 `--force` 重建登记表。

更早的单文件根提示安装，先读出名称、人格、方法、结构，再用这些选项执行 `install --force`。已有档案和会谈保留。

## 操作说明

- 安装、更新始终用 CLI，不自行重做文件逻辑。
- 命令使用绝对路径。
- 本中文版本使用本地 `bin/inner-dialogue.js`；更新工具包本身后，咨询目录才能获得新的中文内容。
- 上游 npm 包仍是独立来源，本地中文修改不会自动发布到那里。

---

## 维护者说明

编辑框架、CLI、人格、方法、结构，提到发布、版本、标签、npm，或在本仓库提交，说明正在维护项目，不是创建私人咨询目录。

### 发布

用户明确要求发布时，阅读并按 `RELEASING.md` 执行：选择版本、更新版本与变更记录、提交并推送标签、检查 CI、确认发布结果。原上游通过 npm Trusted Publishing，无须 npm 令牌。中文版本的仓库与发布权限需按实际目标配置。

### 添加内容

在对应目录添加 Markdown，顶部写 `<!-- version: X.Y.Z -->`。CLI 自动发现，无须手工登记；同步清单和变更记录，按新增内容安排次版本。

### 修改 CLI

改参数或输出结构属于不兼容变化，需主版本。改版本登记格式要兼容迁移。影响用户时更新发布和入门文档。发布前在临时目录执行完整安装验证。

## 可选咨询／朋友／助手模式

用户明确希望模式选择时，读取 `docs/DUAL-MODE.md` 和 `docs/ASSISTANT-MODE.md`，在原安装命令增加 `--dual-mode`；已有目录用 `dual-mode --path <目录> --dry-run` 先预览再启用，已经启用的目录通过本地 `update` 升级。命令名兼容旧版，现支持三种模式；普通安装默认维持原咨询流程。只有朋友模式选择人格和篇幅，咨询与助手直接锁定。助手只加载资料导航、来源说明和存储协议，不加载项目的身份、风格、回复篇幅或其他模式的行为规则。需要新模式时建立没有历史的对话，不在旧历史或分支中切换。
