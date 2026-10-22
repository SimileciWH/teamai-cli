# 快速开始

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

| 要做的事 | 章节 |
| --- | --- |
| 建团队仓库 | [搭建团队](#搭建团队) |
| 加入已有仓库 | [加入团队](#加入团队) |
| 把写好的 skill 或 rule 等 AI 资产分享给团队 | [分享给团队](#分享给团队) |

### 搭建团队

1. 在 GitHub、GitLab、GitCode、CNB、工蜂或私有 Git 上建一个空仓库。名字用 `<团队名>-teamai` 比较好认。给同事分支写权限，主干保持保护。还没有仓库？到 [teamai-hub](https://github.com/teamai-hub) Fork 一个。
2. 在你使用 AI 工具的项目里初始化。

   在 AI 工具里：
   ```text
   安装 teamai skill：https://github.com/Tencent/teamai-cli/tree/main/skills/teamai ，加载 teamai skill，然后从零为我的团队搭建 TeamAI。
   ```
   或在终端里：
   ```bash
   cd /path/to/my-workspace
   teamai init https://github.com/your-org/your-repo
   ```
   `init` 会识别 Git 平台、需要时让你登录、把你登记为成员、给找到的 AI 工具装上会话启动钩子，最后做一次 pull。
3. 检查一下。
   ```bash
   teamai doctor      # 每一行都应通过
   teamai status      # 刚 init 完应为空
   ```
4. 先发一个文件，免得第一次 pull 是空的。把 skill 放到 `~/.claude/skills/<名称>/SKILL.md`（或把 rule 放到 `~/.claude/rules/<名称>.md`），运行 `teamai push`。合并它开出的 pull request。
5. 把仓库地址发给同事。

更多管理功能请参考[分发管理机制](./distribution.md)。

### 加入团队

需要仓库地址。

1. 在你使用 AI 工具的项目里初始化。

   在 AI 工具里：
   ```text
   /teamai 帮我加入团队的 TeamAI，仓库地址是 https://github.com/your-org/your-repo
   ```
   或在终端里：
   ```bash
   cd /path/to/my-workspace
   teamai init https://github.com/your-org/your-repo
   ```
   加上 `--scope user` 会装到用户主目录，这台机器上的每个项目都能看见。不加的话，文件只进当前目录对应的 workspace，所以要在源码 checkout 里执行，不要在用户主目录里执行：在用户主目录下 init 会直接停止，并提示进入源码 checkout 或明确加 `--scope user`。
2. 检查一下。
   ```bash
   teamai doctor
   teamai list        # 团队的 skills、rules、docs、env、agents、hooks 和 MCP server
   ```
3. 在这个项目里打开 AI 工具。

日常命令见[成员使用](./member-guide.md)。检索同事记下的经验，看[团队上下文](./knowledge.md)。

### 一行接入项目

管理员在 `teamai.yaml` 加入以下配置后，RD 只需 `teamai init <资源仓地址>`，不用再选择角色、项目和工具：

```yaml
onboarding:
  defaultRole: rd
```

`rd` 必须存在于 `manifest/roles.yaml`。管理员还需在 `manifest/projects.yaml` 的各项目下填写 `repositories`，列出对应源码 Git 地址。SSH、HTTPS 地址分别登记；匹配保留主机、协议、非默认端口和仓库路径，不看目录名或分支名。无法匹配或匹配多个项目时停止，不保存错误绑定。维护者仍可显式使用 `--role`、`--project`、`--agent`。

RD 在代码目录执行短命令，默认绑定工作区。CLI 检测 PATH 中的 **OpenCode、Pi、Codex、Kimi、Claude Code**，已安装的接入，未安装的跳过，不自动安装客户端。随后立即同步资源、等待团队的 `postPull` 步骤，最后汇总项目、角色、接入工具、跳过项和同步结果。声明的脚本缺失、失败或仍未结束时，不显示已完成。五个工具都没安装时，只保存绑定和空工具白名单。

同一绑定重复运行短命令，会保留原角色、项目选择及禁用工具，并检测新增客户端；日常更新仍用 `teamai pull`。没有启用 `onboarding` 的团队、用户级安装和单仓库模式沿用原流程。AI 客户端仍可能读取已有全局资源，工作区绑定不等于客户端安全隔离。

### 分享给团队

你本地有一个 skill、rule、agent 或 MCP server，同事也要用。

1. 推上去。

   在 AI 工具里：
   ```text
   /teamai 把我的 <名称> skill 分享给团队
   ```
   或在终端里：
   ```bash
   teamai push                       # 从它在你的 AI 工具里找到的资源中挑选
   teamai push --skill ~/.claude/skills/<名称>
   ```
   `push` 会补全 `SKILL.md` 缺失的 frontmatter，推一个分支，并在团队仓库上开 pull request。
2. 团队仓库的评审人合并这个 pull request。
3. 同事机器上下一次会话会拉到。在那之前，`teamai list skills --source repo` 已经能看到。

pull request 已合并，并且 `teamai list skills --source repo` 能看到这个 skill。

角色和 namespace 见[分发管理机制](./distribution.md)。每种资源的格式见[基础 Harness](./sharing.md)。

### 命令失败了

跑 `teamai doctor`。钩子缺失、工具没识别到、token 没设置，它会点名并给出修法。其他情况见[卸载与常见问题](./faq.md)。

## 接下来

| 接下来 | 去看 |
| --- | --- |
| 在 AI 工具里用 `/teamai` | [teamai skill](./skill.md) |
| 更多管理功能 | [分发管理机制](./distribution.md) |
| skills、rules 等怎么写 | [基础 Harness](./sharing.md) |
| 加入之后怎么用 | [成员使用](./member-guide.md) |
