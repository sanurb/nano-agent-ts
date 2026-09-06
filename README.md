# nano-agent-ts

A coding agent built with TypeScript and Bun. This is my project for learning how agents work by building one. It started with the [CodeCrafters challenge](https://codecrafters.io/challenges/claude-code).

## Design decisions

- [Can work run concurrently in one session?](docs/adr/0002-session-branch-lane-ownership.md) Why run ownership belongs to lanes, the alternatives, and how this relates to Pi 2.
- [Why not serialize the whole tool batch?](docs/adr/0001-adjacent-tool-groups.md) The trade-off between adjacent parallel groups and dependency scheduling.

## Develop

Use Bun on macOS or Linux, with `/bin/sh` available.

```sh
git clone https://github.com/sanurb/nano-agent-ts.git
cd nano-agent-ts
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
```

Tests sit next to the code. The default suite uses local provider fixtures, not paid model calls. Docker tests require `NANO_AGENT_TEST_SANDBOX_IMAGE`.

## Run

The default execution mode requires a local Linux Docker daemon and a reviewed sandbox image. Replace `BASE_IMAGE_DIGEST` with a reviewed Bun image digest. Rebuild after tool code or dependency changes.

Use a workspace you own without secrets. Live requests can incur charges, and tools can change workspace files.

```sh
docker build -f Dockerfile.sandbox \
  --build-arg BUN_IMAGE="oven/bun@sha256:BASE_IMAGE_DIGEST" \
  -t nano-agent-sandbox .
export NANO_AGENT_EXECUTION=sandbox
export NANO_AGENT_SANDBOX_IMAGE="$(docker image inspect --format '{{.Id}}' nano-agent-sandbox)"
export OPENROUTER_API_KEY="YOUR_OPENROUTER_API_KEY"
bun run dev -p "Read README.md and summarize the project."
```

Setting `NANO_AGENT_EXECUTION=unsafe-local` bypasses Docker and permits shell commands with your host user permissions; it is not isolation.

For configuration, start with [CLI input](app/cli/cli-configuration.ts) and [execution configuration](app/cli/execution-configuration.ts). If startup reports unresolved tool executions, use the [journal CLI](app/cli/journal-main.ts) to inspect and reconcile them. Do not delete the journal to bypass recovery.

## Find the code

| Area | Start here |
| --- | --- |
| CLI and dependency setup | [app/main.ts](app/main.ts), [your_program.sh](your_program.sh) |
| Sessions and branches | [conversation-session.ts](app/session/conversation-session.ts) |
| Lane ownership and concurrency | [agent-harness.ts](app/agent/agent-harness.ts), [tests](app/agent/agent-harness.test.ts) |
| Agent loop and tool scheduling | [agent-lane.ts](app/agent/agent-lane.ts), [batch tests](app/agent/tool-batch.test.ts) |
| Provider integration | [openrouter-provider.ts](app/providers/openrouter-provider.ts) |
| Tool registration and execution | [local-tools.ts](app/tools/local-tools.ts), [app/tools/](app/tools/) |
| File mutation coordination | [file-mutation-queue.ts](app/tools/file-mutation-queue.ts), [atomic-file-mutation.ts](app/tools/atomic-file-mutation.ts) |
| Tool evidence and recovery | [journaled-tool-executor.ts](app/agent/journaled-tool-executor.ts), [sqlite-execution-journal.ts](app/session/sqlite-execution-journal.ts) |
| Evaluations | [app/evaluation/main.ts](app/evaluation/main.ts) |
| Compiler and lint rules | [tsconfig.json](tsconfig.json), [.oxlintrc.json](.oxlintrc.json) |

## Documentation

Keep documentation limited to:

- [Glossary](CONTEXT.md): domain terms, not implementation details.
- [ADRs](docs/adr/): decisions, rejected alternatives, and trade-offs.
- This README: setup and links to code and tests.

Code and executable tests define behavior. Keep names clear and tests next to the code. Add an ADR when a non-obvious choice has alternatives and costs that code cannot explain. Link to executable evidence and state what it does not prove. Do not add research archives, tutorials, or duplicate implementation summaries. Use short, direct prose and preserve precise technical terms.

## References

These resources helped me build this project:

- [Pi](https://github.com/earendil-works/pi)
- [Claude Code From Scratch](https://github.com/Windy3f3f3f3f/claude-code-from-scratch)
- [How Claude Code Works](https://github.com/Windy3f3f3f3f/how-claude-code-works)

The latter two are independent learning resources, not official Claude Code specifications.

## Contribute and get help

[David Urbano (@sanurb)](https://github.com/sanurb) maintains this project. Open a [GitHub issue](https://github.com/sanurb/nano-agent-ts/issues) for questions or proposed changes. Keep changes focused, add tests, and report the checks you ran. Do not share keys, private prompts, or execution journals.

This project is released under the [MIT License](LICENSE). A reference project's license does not apply here.
