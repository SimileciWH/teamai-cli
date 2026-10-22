# RAYMX 内部分发

这个 fork 使用公司发布安装器。编译后的程序禁用所有 npm 版本查询和自行更新入口，包括 Stop hook；团队配置丢失或损坏时也不会切换到公网 npm 版本。

内部安装器提供的命令入口把 `teamai update`、`teamai update --check` 交给公司 NAS 更新流程。直接运行包内 CLI 时，只提示使用内部安装器，不访问 npm。`teamai pull` 继续从配置的 Git 仓库同步团队资源。

安装器必须运行在 AI 工具所在的操作系统和用户环境中，Windows 原生与 WSL 分别安装。安装器保留历史版本，激活前校验运行包，不要求管理员权限。

知识仓包含多个版本的发布资料，首次从 Gerrit 完整克隆可能需要几分钟。通用 Git provider 的克隆等待上限为 10 分钟，超时错误会保留系统原因；后续 `pull` 只传输增量。

工作区的 `teamai init <资料仓 URL>` 要在实际的源码 Git checkout 中执行。源码的父目录、仅与项目同名的空目录都不算 checkout；遇到这些目录时，init 在认证、克隆和写配置前就停止并提示切换目录。用户级公共资源使用 `--scope user`；HTTP 接入继续支持无 Git 环境。源码 remote 未登记时显示简短错误，不会绑定到错误项目。
