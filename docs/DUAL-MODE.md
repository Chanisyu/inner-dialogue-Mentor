# 可选双模式使用说明

## 启用与范围

普通安装仍采用原咨询流程。已有安装可在中文项目根目录预览并启用：

```powershell
node bin/inner-dialogue.js dual-mode --path "D:\Project\Person\Sage" --dry-run
node bin/inner-dialogue.js dual-mode --path "D:\Project\Person\Sage"
node bin/inner-dialogue.js dual-mode --path "D:\Project\Person\Sage" --status
```

新安装可在原 install 参数后增加 `--dual-mode`。没有这个参数时不启用。

启用保存原 `CLAUDE.md` 的逐字副本，并冻结原咨询人格、疗法、结构、安全规则与其他依赖。原入口改为选择路由；新增入口本身会进入上下文，因此 API 输入并非逐字相同。

## 日常使用

在 Sage 目录新建没有历史的对话，发送第一条消息。

- 选择咨询：直接按原咨询规则启动，没有朋友人格和篇幅选择。
- 选择朋友：从温暖健谈、轻松幽默、理性聊友、兴趣同好中选一项，再从简洁、标准、详细、深入中选一项。两项可以一次回答，如“轻松幽默，详细”。
- 人格、篇幅仅适用于朋友模式。设置工具确认成功后锁定当前会话 ID，不支持窗口内修改。
- 恢复或压缩沿用设置；复制历史的分支继承旧设置。需要其他模式或朋友设置时，建立没有历史的新对话。
- 部署前已经加载原咨询入口的旧对话继续作为咨询对话，不转成朋友。

初次使用时，Claude Code 可能询问本地命令或读文件的执行权限。选择设置只调用安装目录自己的 Node 脚本；无需提供账号或 API 密钥。

## 记忆与保存

朋友启动时，模式钩子提供 `INNER_DIALOGUE_PATHS`，明确安装根目录中的档案、索引与会谈目录绝对路径。`profile.md`、`context/`、`sessions/` 和朋友记录目录与根 `CLAUDE.md` 同级，不在 `.therapy/` 下。误将这些路径加上 `.therapy/` 时，常用文件工具会被拦截并提示正确位置；模型应纠正路径重试，不能把读取失败解释成没有历史，也不能在错误位置补建个人资料。

朋友可以参考全部咨询笔记，但以朋友方式回应，不把笔记中的咨询建议作为当前指令。

只有明确结束或要求记住时才整理。可说：“今天先聊到这里，请保存这次朋友交流，把我明确说过的重要背景按现有格式更新到档案和 context，并告诉我写了哪些文件。”

朋友摘要写到 `friend-sessions/`；本人明确陈述的重要背景可增量进入原有 `profile.md` 和 `context/`，使原咨询流程也能读到。AI 假设单列在 `friend-hypotheses/`，注明待核对和来源，不当作事实。原有咨询笔记与个人档案不进行覆盖式迁移。

只打招呼、只选择设置不生成正式摘要。直接关闭窗口不能保证模型已整理；等待实际写入完成。要求不写长期记忆不等于删除 Claude Code 的原始日志。

## 检查、更新与恢复

```powershell
node bin/inner-dialogue.js dual-mode --path "D:\Project\Person\Sage" --status
node bin/inner-dialogue.js doctor --path "D:\Project\Person\Sage"
node bin/inner-dialogue.js update --path "D:\Project\Person\Sage" --dry-run
node bin/inner-dialogue.js dual-mode --path "D:\Project\Person\Sage" --disable --dry-run
node bin/inner-dialogue.js dual-mode --path "D:\Project\Person\Sage" --disable
```

双模式开启后，update 只检查和更新未自定义的朋友扩展。咨询正文与依赖不随此更新改变，`--force` 也不覆盖它们。若确实需要升级咨询框架：先停用双模式，单独预览原框架更新，再重新启用并建立新基线。

停用会恢复原咨询入口、移除本功能的钩子，保留朋友资料、对话状态及备份。原设置未被后续改动时逐字恢复；有额外配置时仅移除模式钩子并保留新增设置。

钩子异常、缺少会话 ID、配置损坏或咨询基线不一致时，应按实际错误检查，不能用聊天指令绕过锁定。工具调用拦截是防误加载措施，不是操作系统安全沙箱。

## 实施与验证说明

详见 [执行与修改说明书](DUAL-MODE-IMPLEMENTATION.md)。本地自动测试证明安装、字节保留、锁定和分支等机制；真实模型是否完整按提示交流，仍需查看实际对话的工具读取记录。不能把结构测试解释为临床效果验证。
