# Keep assistant orchestration independent of the provider SDK

The original `app/main.ts` owned configuration, OpenAI payloads, tool declarations,
and rendering. Following Pi's harness design, an application-owned
`AssistantProvider` interface now separates request construction from the
OpenRouter Adapter, which owns authentication, protocol translation, parsing, and
safe failures. Keeping the concrete SDK in the harness would save an interface
but spread provider mechanics into future tool-loop and session work; copying
Pi's entire durable runtime now would add unsupported behavior to a one-request
challenge. We adopt the module separation, not Pi's durability
guarantees; the exact scope is recorded in [architecture.md](../architecture.md).
