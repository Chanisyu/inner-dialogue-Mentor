# Inner Dialogue · 简体中文版

一个保存在自己电脑上、通过文件保持会谈连续性的 AI 心理支持工具包。你可以选择咨询师名称、交流人格、会谈结构和心理咨询方法，积累自己的档案、会谈笔记与背景资料。

本项目从英文开源版本中文化而来。人格与已翻译疗法优先复用 Willow 中经校对的译文，其余内容按原文补译。中文化保留原有的咨询原则、默认回复长度与安全边界，不额外加入限制提问、禁止分析或预设个人经历的规则。

AI 并非持证心理咨询师，也不能替代现实中的专业支持。工具包的文件在本地保存；如果连接云端模型，发送给模型的消息和读取到的文件内容仍由相应服务商处理。

## 开始使用

需要 Node.js 18.3 或更新版本，以及能够在咨询目录中读取和写入文件的 Claude Code 或 Codex 本地环境。安装和更新中文版本时，请使用这份本地项目；从上游 npm 下载的版本可能仍是英文。

在本项目根目录运行交互式安装：

```powershell
node bin/inner-dialogue.js install
```

或一次指定配置：

```powershell
node bin/inner-dialogue.js install --name 柳 --path D:/Therapy/Willow --persona warm-4o --structure moderate --modalities cbt,ifs
```

安装后，在 Claude 应用或 Codex 中选择生成的咨询目录作为主目录，也可进入该目录运行 `claude` 或 `codex`。两个客户端共用档案、背景、摘要及原文，分别保留每条对话的设置。首次使用 Codex 时按客户端要求信任钩子，详见[跨客户端使用说明](docs/CROSS-CLIENT.md)。项目根目录的入口用于安装维护，咨询目录中的入口才用于日常对话。

详细步骤见[入门指南](docs/GETTING-STARTED.md)。如果需要整理原有的英文安装，参见[迁移指南](MIGRATING.md)。

## 交流人格

人格改变表达方式，疗法决定使用什么心理咨询方法；人格本身不代表诊断或疗效。

| 标识 | 中文名称与风格 |
| --- | --- |
| `warm-4o` | 温暖自然：亲近、共情、口语化，像一位细心的朋友 |
| `warm-supportive` | 温暖支持：接纳、耐心，先营造安全感 |
| `direct-challenging` | 直接挑战：坦率指出模式，适合愿意接受挑战的人 |
| `coach` | 行动教练：强调目标、行动与后续落实 |
| `grounded-real` | 务实真诚：自然、诚恳，不用咨询腔 |
| `contemplative` | 沉思留白：留出空间，重视觉察与当下体验 |
| `philosophical` | 哲学与存在探索：讨论意义、价值、存在与选择 |
| `creative` | 创意探索：使用隐喻、想象与非线性的探索方式 |

原项目的人格普遍偏好简短自然的来回交流。需要详细分析或分步计划时，可以直接提出；换人格并不自动保证更长回复。

## 心理咨询方法

可以组合多种方法，也可以在会谈中调整。以下是方法说明，不是对个人适用性的判断。

| 标识 | 方法 | 主要关注 |
| --- | --- | --- |
| `cbt` | 认知行为疗法 | 思维、情绪与行为的相互影响 |
| `act` | 接纳与承诺疗法 | 心理灵活性、价值与承诺行动 |
| `cft` | 慈悲聚焦疗法 | 自我批评、羞耻与自我慈悲 |
| `dbt-skills` | 辩证行为疗法技能 | 正念、痛苦耐受、情绪调节、人际效能 |
| `ifs` | 内在家庭系统 | 内在不同部分及其保护作用 |
| `lifespan-integration` | 人生跨度整合 | 时间线、记忆与当下安全感的连接 |
| `motivational-interviewing` | 动机式访谈 | 对改变的矛盾感与自主选择 |
| `narrative` | 叙事疗法 | 将人与问题分开，重写主导故事 |
| `polyvagal` | 多迷走神经理论知情工作 | 身体状态、安全感与调节 |
| `psychodynamic` | 心理动力学取向 | 无意识模式、早期经验与关系 |
| `sfbt` | 焦点解决短期疗法 | 例外、已有资源与可行的下一步 |
| `somatic-experiencing` | 躯体体验取向 | 身体感受、渐进接触与调节 |
| `ideal-parent-figure` | 理想父母形象 | 依恋需求与修正性的想象体验 |

## 会谈结构

- `structured`：有明确的开场、重点探索、总结与行动安排。
- `moderate`：保留轻量的方向感，同时允许自然展开。
- `freeform`：跟随当下最重要的内容，不强制议程。

## 文件与记忆

```text
你的咨询目录/
├── CLAUDE.md                    日常咨询指令
├── profile.md                   个人档案
├── sessions/                    按日期保存的会谈笔记
├── context/
│   ├── index.md                 背景资料索引
│   ├── people/                  人物
│   ├── places/                  地点
│   ├── concepts/                概念与主题
│   └── events/                  事件
├── .claude/settings.json        本地钩子配置
└── .therapy/
    ├── persona.md               当前人格
    ├── session-structure.md             当前结构
    ├── modalities/              当前启用的方法
    ├── library/                 完整中文选项库
    ├── safety-protocol.md       安全流程
    ├── profile-protocol.md      档案确认与复核规则
    ├── usage-reflection.md      使用节奏的讨论原则
    ├── hooks/                   机械辅助钩子
    └── version.json             哈希、版本、语言与本地来源
```

文件形成持续记录，不等于模型每次都会完整读取所有历史。启动指令要求读取档案、当前配置、近期会谈与索引，并按需要读取相关背景；实际读取仍取决于运行环境和模型执行情况。近期会谈优先于较旧的背景摘要，未经确认的总结应作为有日期的假设。

当前状态的档案条目记录最后确认日期；成长背景不强行标日期。约 90 天未确认且至少经过约 3 次会谈后，咨询师可在适当时机征求复核。不会编造旧记录的确认日期。

## 导入与自定义

直接对咨询师说“导入我的既有记录”“更换人格”“调整会谈结构”“添加一种疗法”“复核我的档案”或“建立背景资料库”。命令细节见 [commands.md](commands.md)。

导入的真实专业人员记录使用 `therapist:` 来源标记，与 AI 自己写的笔记区分。AI 不应将自己的内容伪装成真人专业记录，也不应覆盖真实治疗团队的判断。

## 安全辅助与使用统计

安全流程正文是主要依据。`UserPromptSubmit` 钩子额外匹配部分中英文、第一人称危机措辞，匹配后提醒模型重新读取安全流程。它采用有限的规则，会漏报或误报，不能承担临床风险判断；出错时静默放行。

该钩子的注册格式要求 Claude Code 至少为 `2.1.139`。`doctor` 检查文件、哈希、注册与运行条件；环境允许时，还会在临时目录中测试钩子是否实际执行。测试消息会被另一个钩子拦截，不发送给模型，不保存为正常会谈。

`SessionStart` 钩子把会谈时间写入本地 `.therapy/usage-log.txt`，在有足够历史时提供次数、间隔与个人基线等事实。咨询师按 `usage-reflection.md` 判断是否温和地提一次。它不把高频使用直接解释为危机。工具本身不上传统计；注入会谈的统计会成为模型上下文的一部分。

统一运行日志保存在 `.therapy/logs/runtime.jsonl`，记录会话启动、工具成功或失败、模式拦截及 CLI 结果，供按会话 ID 排错。只保存诊断元数据，不保存聊天、档案、工具输出正文、命令或原始错误文本。每个文件约 2 MiB 后轮转，保留三个历史文件；新安装默认启用，已有目录通过本地 `update` 接入。说明和查看方法见[运行日志](docs/RUNTIME-LOGGING.md)。

## 检查与更新中文版本

始终在这份中文项目中运行：

```powershell
node bin/inner-dialogue.js doctor --path D:/Therapy/Willow
node bin/inner-dialogue.js update --path D:/Therapy/Willow --dry-run
node bin/inner-dialogue.js update --path D:/Therapy/Willow
```

更新依据登记的哈希比较文件。未修改的框架文件可自动更新；自行改过或来源不明的文件默认保留。`--force` 会覆盖相应框架文件，写入前先保存备份，因此应先预览计划。

`profile.md`、`sessions/`、背景资料和现有根目录 `CLAUDE.md` 不会被普通更新覆盖。已登记且未修改的当前人格、结构和疗法可以随框架更新。中文模板中的新启动规则不会通过普通更新自动写入旧 `CLAUDE.md`，迁移方式见 [MIGRATING.md](MIGRATING.md)。

新安装的 `.therapy/version.json` 包含 `locale: "zh-CN"` 和 `source_path`，使会谈中的更新命令能找到本地中文来源。移动或删除来源项目后，应先恢复正确的来源路径。

## 隐私与保存

- 主动收尾后可归档双方原话：模型先登记请求，最后回应完成后才保存到 `transcripts/`，包含精简 JSONL 与 Markdown。普通回复和关闭窗口不会归档，安装或更新不会自动导入旧会话。完整说明见[原始对话归档](docs/TRANSCRIPT-ARCHIVING.md)。
- 档案、笔记、背景、配置和统计保存在咨询目录中；本项目没有中央会谈数据库。
- 使用云端模型时，发送的内容仍受模型提供商、代理服务和账户设置的数据政策约束。“文件在本地”不等于“内容从未离开电脑”。
- 检查操作系统备份、云盘同步、版本控制和设备共享情况。需要额外保护时，参见[安全与加密指南](SECURITY.md)。
- 保存期限、训练使用与删除政策可能变化，请以实际使用的服务商政策为准：[Anthropic 隐私说明](https://privacy.claude.com/)、[OpenAI 数据控制说明](https://help.openai.com/en/articles/7730893-data-controls-faq)。

## 常见问题

**能代替现实中的咨询吗？** 不能。它可以支持自我反思、整理信息和练习技能，无法提供专业人员的责任、现场判断或紧急干预。

**会一直记住全部内容吗？** 文件可以持续保留，但模型的上下文窗口和实际文件读取有边界。会谈笔记与背景索引用于帮助延续，不构成完整记忆的保证。

**能使用其他模型吗？** 模板是文本，能否正确执行取决于接入环境的文件工具、指令遵循和上下文能力。本工具包不控制第三方模型的思考档位或推理参数。

**能直接把模板贴进普通聊天窗口吗？** 可以作为提示词参考，但自动读取本地文件、保存笔记和运行钩子需要支持这些操作的运行环境，粘贴文本本身不会提供这些功能。

**可以随时修改或离开吗？** 可以。资料是普通文本文件；可以备份、移动、检查或删除。更新前检查计划即可保留自己的框架改动。

## 开发与支持

```powershell
npm test
npm run test:evals
npm run test:zh-safety
npm pack --dry-run
```

评测说明见 [evals/README.md](evals/README.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。英文回归用例、文件名、命令参数和机器字段保留原标识，以维持兼容性。

原作者：[Anthony Taglianetti](https://github.com/ataglianetti)。支持原项目：[Buy Me a Coffee](https://buymeacoffee.com/ataglianetti) · [GitHub Sponsors](https://github.com/sponsors/ataglianetti)。项目受到 [r/therapyGPT 社区](https://reddit.com/r/therapyGPT) 及其保持 AI 会谈连续性的实践启发。框架包含 CBT、ACT、DBT 等方法的原则。

采用 [MIT 许可证](LICENSE)；英文许可证原文保留。

## 可选双模式扩展

本中文版本增加可选的朋友／咨询双模式。朋友可以选择四种人格及四种篇幅，设置按对话锁定；咨询沿用原有正文、人格和篇幅要求。普通安装默认不开启。已有目录先运行 `dual-mode --dry-run` 预览，详见 [双模式使用说明](docs/DUAL-MODE.md)及[执行与修改说明书](docs/DUAL-MODE-IMPLEMENTATION.md)。
