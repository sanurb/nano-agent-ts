# Agent conversations

The language for conversations, parallel assistant work, and retained history.

## Language

**Session**:
The shared history containing related conversation branches.
_Avoid_: Chat window, worker

**Branch**:
A named path through conversation history, ending at its current tip.
_Avoid_: Copy, session

**Agent lane**:
A branch with its own model and tool configuration and exclusive ownership of its
active assistant work. A lane need not be a delegated agent or a separate worker.
_Avoid_: Thread, subprocess, subagent

**Assistant step**:
One model response, which may request tools rather than finish the user's task.
_Avoid_: Completed run, completed task

**Agent run**:
The assistant steps and tool executions performed for one accepted user prompt,
ending with a final response or a failure.
_Avoid_: Assistant step, durable workflow

**Tool call**:
An assistant's request for a tool effect, not evidence that the effect occurred.
_Avoid_: Tool result

**Tool result**:
The output of a completed tool call, linked to that call in the conversation.
_Avoid_: Tool request, final assistant answer

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
