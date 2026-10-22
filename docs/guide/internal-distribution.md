# RAYMX internal distribution

This fork uses the company release installer. All npm version checks and self-update paths, including Stop hooks, are disabled in compiled code. Missing or damaged team configuration cannot switch this build to public npm.

The installed internal launcher handles `teamai update` and `teamai update --check` through the company NAS. Invoking the bundled CLI directly prints the internal installer guidance and does not contact npm. `teamai pull` continues to synchronize team resources from the configured Git repository.

Install in the same operating system and user environment as the coding agent. Windows-native and WSL installations are separate. The company installer preserves previous versions and verifies the runtime before activation; it does not require administrator privileges.

The knowledge repository contains release bundles for multiple versions, so the first full Gerrit clone can take several minutes. The generic Git provider allows up to ten minutes and preserves the operating-system error on failure. Subsequent pulls transfer changes incrementally.

Run workspace `teamai init <team-repo-url>` from your actual source Git checkout. A parent directory or an empty folder named after the project is not a checkout: init stops before authentication, cloning or configuration writes. In your home directory, init never falls back to user scope on its own either: without `--scope` it refuses before authenticating, cloning or writing config, and tells you to enter a source checkout or pass `--scope user` explicitly. `--scope user` keeps working in the home directory and in any other directory. For resources shared across your user account, use `--scope user`. HTTP setup retains its Git-free behavior. An unregistered source remote produces a concise error without binding the wrong project.
