# Diagnostics and maintenance

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

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

`doctor` exits 1 for blocking failures, such as missing resources, unreadable configuration or failed plugin checks. A readable personal Skill or an unowned MCP definition that `pull` preserves is reported as a warning; it does not block CLI updates or overwrite the personal copy. In `--json`, such a check has `ok: false, warning: true`, while the report's `ok` remains true if no blocking failure exists. A mix of warnings and failures still exits 1.

`stats` adds a recall section when that scope has recall runs. See [Recall adoption and upvotes](./knowledge.md#recall-adoption-and-upvotes).

Auto-update runs when a session ends. The team can turn it off. A member's own policy wins:

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml
updatePolicy: skip    # auto, prompt, or skip
```
