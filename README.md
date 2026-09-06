[![progress-banner](https://backend.codecrafters.io/progress/claude-code/3a9dab40-e6ab-4ee6-99d1-4ce129a16075)](https://app.codecrafters.io/users/sanurb?r=2qF)

This is a starting point for TypeScript solutions to the
["Build Your own Claude Code" Challenge](https://codecrafters.io/challenges/claude-code).

Claude Code is an AI coding assistant that uses Large Language Models (LLMs) to
understand code and perform actions through tool calls. In this challenge,
you'll build your own Claude Code from scratch by implementing an LLM-powered
coding assistant.

Along the way you'll learn about HTTP RESTful APIs, OpenAI-compatible tool
calling, agent loop, and how to integrate multiple tools into an AI assistant.

**Note**: If you're viewing this repo on GitHub, head over to
[codecrafters.io](https://codecrafters.io) to try the challenge.

# Development

```sh
bun install
bun run lint
bun run typecheck
bun run test
```

The CLI runs an agent loop with `Read`, `Write`, and `Bash`, sends each tool result
back to the model, and prints only the final assistant answer. `Write` creates or
overwrites files with the supplied UTF-8 content; parent directories must already exist.
`Bash` runs a command through `/bin/sh` in the working directory and returns its combined
stdout and stderr, including the exit status of a failed command. It is not sandboxed.
Runs default to a 64-step model-call budget; tool and provider failures stop with safe errors.
The library supports explicit named lanes, concurrent requests
across lanes, shared-history branching, and history-preserving context-window
rollover—all in memory. The CLI acquires only `main`, with no background calls.
See [Agent architecture](docs/architecture.md) for two-lane usage and limitations,
and [Pi/Posthorse research](docs/research/pi-lanes-and-context.md) for source findings.

# Passing the first stage

The entry point for your `claude-code` implementation is in `app/main.ts`. Study
and uncomment the relevant code, and submit to pass the first stage:

```sh
codecrafters submit
```

# Stage 2 & beyond

Note: This section is for stages 2 and beyond.

1. Ensure you have `bun (1.3)` installed locally.
2. Run `./your_program.sh` to run your program, which is implemented in
   `app/main.ts`.
3. Run `codecrafters submit` to submit your solution to CodeCrafters. Test
   output will be streamed to your terminal.
