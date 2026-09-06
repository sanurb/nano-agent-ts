# Agent conversations

The language for conversations, parallel assistant work, and retained history.

## Language

**Session**:
The shared history containing related conversation branches, not one active model
context or one running task.
_Avoid_: Chat window, worker

**Branch**:
A named path through conversation history, ending at its current tip. Branches can
share earlier entries without sharing their later messages.
_Avoid_: Copy, session

**Branch tip**:
The last entry on a branch's selected path, or no entry for an empty path.
_Avoid_: Latest session entry

**Agent lane**:
A branch with its own model and tool configuration and one active request or run
at a time. A lane is not a thread, subprocess, or permission boundary.
_Avoid_: Thread, subprocess, subagent

**Agent harness**:
The owner of related lanes and their shared session, not an active lane itself.
_Avoid_: Main lane, agent run

**Assistant step**:
One model response, which may request tools rather than finish the user's task.
_Avoid_: Completed run, completed task

**Agent run**:
The assistant steps and tool executions performed for one accepted user prompt,
ending with a final response, an explicit stop, cancellation, or failure.
_Avoid_: Assistant step, durable workflow

**Tool call**:
An assistant's request for a tool effect, not evidence that the effect occurred.
_Avoid_: Tool result

**Tool batch**:
The tool calls requested by one assistant message, together with their outcomes.
_Avoid_: Agent run, parallel agents

**Tool outcome**:
The recorded disposition of a tool call, including success, failure, non-execution,
or uncertainty about an effect; not necessarily evidence that an effect occurred.
_Avoid_: Assistant answer, tool request

**Tool result**:
The conversation's representation of a tool outcome, linked to the requesting call.
_Avoid_: Tool request, final assistant answer

**Batch termination**:
A decision to omit the automatic assistant continuation after a settled tool batch;
not cancellation of sibling work or proof that the user's task is complete.
_Avoid_: Cancellation, task completion

**Transcript**:
The complete retained sequence of entries along a branch, including earlier
context windows.
_Avoid_: Active context

**Active context**:
The conversation messages selected for the next model request.
_Avoid_: Transcript, provider-owned conversation

**Context window**:
A region of conversation history whose messages form the active context until
an explicit rollover starts another region.
_Avoid_: Session, branch

**Handoff**:
Caller-supplied continuity text for a new context window, not a verified account
of current external state.
_Avoid_: System instruction, authoritative state
