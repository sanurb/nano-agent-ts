---
status: accepted
---

# Separate shared history from run ownership

Related tasks need common prior context without waiting for one another's model requests. The design uses a session for shared history, a branch for each conversation path, and a lane for configuration and exclusive ownership of an active request or run.

This records the existing design in [AgentHarness](../../app/agent/agent-harness.ts), not a new CLI feature. The [CLI](../../app/main.ts) runs one prompt on `main`.

## Alternatives and trade-offs

| Option | Benefit | Cost |
| --- | --- | --- |
| One active run per session | One conversation path and a simple ownership rule | Unrelated work waits through model and tool I/O |
| A separate session for each task | Independent histories and execution | Callers must copy shared context and track its origin |
| Concurrent runs on one branch | Both runs append to one path | Requires a policy for which in-flight prompts and results each request can see |
| One active run per lane, with separate branches in one session | Shared ancestry and independent execution | Callers must pass findings between lanes and coordinate shared resources |

We use the last option. A branch's history and a run's ownership have different scopes. A session-wide run lock would couple them without resolving conflicts in external resources.

## Consequences

A review lane and an implementation lane can start from the same entry. Their later messages follow separate paths. Shared storage does not mean that either model automatically receives the other's findings. Combining those findings remains a caller decision; there is no branch merge operation.

Lane ownership lasts through tool execution and cleanup, not just the model request. Releasing it earlier would admit new work against an unfinished tool batch.

Lanes do not isolate files or grant permissions. [File mutation queues](../../app/tools/file-mutation-queue.ts) coordinate cooperating mutations; they do not lock out arbitrary shell commands or external processes. [Tool-batch scheduling](0001-adjacent-tool-groups.md) is a separate decision.

The local conversation is in memory. Its [tool journal](../../app/agent/journaled-tool-executor.ts) records effect evidence, not resumable conversation state. This decision makes no throughput or restart-recovery guarantee.

## How this relates to Pi lanes

“Pi cannot work concurrently in one session” is too broad. The answer depends on the API and what the caller means by session.

At Pi commit `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`:

- The newer agent-core `AgentHarness` (Pi 2 in this discussion) exposes [named lanes][pi-lanes]. Each lane admits [one active operation][pi-admission].
- Lanes share a [session mutation queue][pi-mutations]. The [generation path][pi-generation] commits intent, awaits the model outside that queue, then publishes the response. Serial state changes do not require serial model requests.
- The legacy coding-agent [`AgentSession.prompt()`][pi-legacy] queues steering or follow-up input, or rejects a prompt while streaming. That is a different interface, not evidence of a session-wide restriction in agent-core.

These are source-level claims at one revision. They do not establish a multi-lane workflow in every Pi CLI or release. This repository uses the ownership distinction, not Pi's full durable operation model.

## Verify the decision

[Harness tests](../../app/agent/agent-harness.test.ts) hold provider requests open, check same-lane rejection, and settle different lanes in either order. They also check shared entry identities and separate descendant histories. [Lane tests](../../app/agent/agent-lane.test.ts) check that another lane can finish while one waits for a tool.

From the repository root:

```sh
bun test app/agent/agent-harness.test.ts app/agent/agent-lane.test.ts
```

These tests check ownership and ordering without paid model calls. They do not measure speedup or coding-task success.

[pi-lanes]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/agent-harness.ts#L538-L612
[pi-admission]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/lane.ts#L562-L595
[pi-mutations]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/session/mutation-line.ts#L1-L23
[pi-generation]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/drive/generation.ts#L277-L302
[pi-legacy]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1159-L1224
