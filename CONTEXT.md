# Coding agent vocabulary

The language for this project's coding agent, its conversations, and its tools,
aligned with [Matt Pocock's AI Coding Dictionary](https://github.com/mattpocock/dictionary-of-ai-coding).

## Language

### Agent and execution

**Model**:
The stateless prediction component that produces text and tool calls from its
input. It does not execute tools or retain conversation history itself.
_Avoid_: Agent, harness, the AI

**Model provider**:
The service that serves a model for inference, whether remote or local.
_Avoid_: Model, harness

**Harness**:
The software around a model that assembles its input, executes tool calls, and
manages conversation history and control flow.
_Avoid_: Model, environment

**Agent**:
The model operating within a harness, configured with tools and context to
respond to a user and act on their behalf.
_Avoid_: Model alone, the AI, the bot

**Model provider request**:
One round-trip from the harness to a model provider, carrying the current input
and returning one model response, which may contain text or tool calls.
_Avoid_: Turn, agent run

**Turn**:
One user message plus the agent's work in response until control returns to the
user. It may contain multiple model provider requests and tool executions; it
need not complete the user's task.
_Avoid_: Assistant step, model provider request, agent run

### Sessions and context

**Session**:
One bounded interaction with an agent, accumulating messages and tool results
across turns until closed, cleared, or handed off to a fresh session.
_Avoid_: Shared history store, branch, context window

**Context**:
The task-relevant information available to the agent right now, rather than the
literal model input or the entire retained history.
_Avoid_: Context window, transcript

**Context window**:
The token sequence the model sees on a model provider request, including supplied
messages, tool definitions, and any standing instructions. Its capacity is finite
and model-specific.
_Avoid_: History segment, transcript, persistent memory

**Transcript**:
The retained record of messages and tool results along a conversation path,
including earlier sessions when their history is kept.
_Avoid_: Context window, active messages

**Clearing**:
Ending a session and starting a fresh one without transferring its accumulated
context. Retaining an old transcript does not make it part of the new model input.
_Avoid_: Compaction, handoff

**Handoff**:
The transfer of context from one session to another so work can continue there.
The transfer is distinct from the text or document used to carry it.
_Avoid_: Handoff text, system prompt, delegation with an expected return

**Handoff text**:
Continuity information supplied to seed a receiving session, not verified evidence
of the environment's current state.
_Avoid_: Handoff itself, system instruction, authoritative state

**Compaction**:
A handoff in which the previous session's history is summarized and the summary
seeds a fresh session. The summary is a lossy account, not the original transcript.
_Avoid_: Clearing, any context reset

### Tools and environment

**Environment**:
The world outside the harness that the agent observes through tool results and
changes through tool execution, such as the working filesystem.
_Avoid_: Harness, runtime

**Tool**:
A function exposed by the harness for the agent to observe or act on its
environment, described by a name, description, and argument schema.
_Avoid_: Tool call, model capability alone

**Tool call**:
Model output naming a tool and its arguments. It requests an effect; it is not
evidence that the harness executed it.
_Avoid_: Tool result, completed action

**Tool result**:
The outcome the harness sends back after executing a tool call, such as file
contents, command output, or an error, linked to the originating call.
_Avoid_: Tool call, final answer

**Subagent**:
An agent spawned by another agent through a tool call, working in its own session
and context window and reporting back as a tool result.
_Avoid_: Agent lane, any concurrent request, handoff

### Project-specific history and scheduling

**Conversation history**:
The retained record shared by related conversation branches, potentially spanning
multiple sessions. Retention alone does not make earlier information visible to
the model.
_Avoid_: Session, context window

**Branch**:
A named path through conversation history, ending at its current tip.
_Avoid_: Copy, session

**Agent lane**:
A branch with its own model and tool configuration and exclusive ownership of its
active agent work. A lane is not inherently a subagent or a separate process.
_Avoid_: Thread, subprocess, subagent

**Active messages**:
The conversation messages selected for the next model provider request. They are
the conversation portion of its context window, not the entire provider input.
_Avoid_: Complete transcript, context window, provider-owned conversation

**Session boundary**:
The point in a branch's history where a fresh session begins, optionally seeded
with handoff text rather than the earlier session's messages.
_Avoid_: Context window, model capacity limit
