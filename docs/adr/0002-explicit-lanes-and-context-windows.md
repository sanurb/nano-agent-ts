# Manage explicit lanes; retain history separately from active context

> Historical scope decision, written before the tool-execution loop was added.
> That loop now exists. This record preserves the original Pi-derived terminology;
> [current architecture](../architecture.md) and [CONTEXT.md](../../CONTEXT.md)
> describe today's behavior and vocabulary.

Following current Pi rather than its historical harness-v2 inheritance model,
`AgentHarness` manages named lanes over one privately owned session, with explicit
`main` acquisition and independently scheduled work instead of a fixed pair of
workers. To add the requested lane foundation without importing a durable runtime
or the fork required by Posthorse, we use synchronous in-memory session mutations
and explicit, branch-local context-window boundaries that preserve history.
Delegation, automatic result promotion, persistence, and automatic rollover remain
separate policies; unresolved tool calls block continuation and rollover until an
executor exists.

The [research](../research/pi-lanes-and-context.md) recommended a tool loop before
lane adoption; that is still the next agent capability, but this request explicitly
prioritized Pi-style lane architecture. The resulting trade-off is a tested
single-step lane primitive—not a completed multi-agent coding assistant—and no
additional model calls or tool effects in the CLI. See
[architecture](../architecture.md) for ownership, failure semantics, and limits.
