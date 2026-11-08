# Security

## Security model

This plugin runs the local OpenCode harness with `--auto`. That mode lets the
model edit files and execute commands without interactive confirmation. Treat
every task as code execution with the privileges of the user running OpenClaw.

Optional task acceptance commands are run through `bash -lc` in the task
repository and have the same privileges. Only register acceptance commands that
you would be comfortable running yourself.

To reduce risk:

- Restrict tasks to trusted repositories. Repositories must resolve inside one
  of the configured `allowedRepoRoots` after `fs.realpath`, so symlink escapes
  are rejected.
- Review diffs and command output after every run.
- Prefer disposable repositories, worktrees, or containers.
- Keep acceptance commands short, auditable, and free of untrusted input.
- Be aware of prompt injection: repository files, issue text, and tool output
  can contain instructions that influence the model. Do not run untrusted
  content against valuable credentials or production systems.

## Reporting a vulnerability

Please report security issues privately through GitHub private vulnerability
reporting instead of opening a public issue:

<https://github.com/avnersorek/OCFree/security/advisories/new>

Repository owner: Avner Sorek.
