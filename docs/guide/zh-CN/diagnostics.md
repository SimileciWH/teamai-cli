# 诊断与维护

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai doctor
teamai doctor --json
teamai stats
teamai update --check
teamai update
teamai digest
teamai remove skills <name>
teamai remove rules <name> --force
```

`doctor` 遇到资源缺失、配置无法读取、插件检查失败等阻断项时，以状态码 1 退出。`pull` 保留的可读取个人 Skill 或非托管 MCP 定义显示为警告，不阻止 CLI 更新，也不覆盖个人版本。`--json` 中这些检查为 `ok: false, warning: true`；没有阻断项时，报告整体 `ok` 为 true。警告与真实失败同时存在时，仍以状态码 1 退出。

`stats` 在有 recall 记录时会多一节，见 [Recall 采纳与 upvote](./knowledge.md#recall-采纳与-upvote)。

自动更新在会话结束时跑。团队可以关掉，成员可以改自己的策略：

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml
updatePolicy: skip    # auto / prompt / skip，优先于团队设置
```
