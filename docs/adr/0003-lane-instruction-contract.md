---
status: accepted
---

# Keep application instructions outside conversation history

[AgentInstructions](../../app/agent/agent-instructions.ts) owns admission, deterministic composition, immutability, and diagnostic identity. Lanes capture a resolved value; only [OpenRouterProvider](../../app/providers/openrouter-provider.ts) translates it into one leading system message. Putting a string in the user prompt would lose role priority; storing a system entry in the branch would make branch ancestry and rollover responsible for policy retention and promotion.

## Ownership and inheritance

The harness parses and captures its application contract at construction. Invalid defaults are retained as a typed admission failure returned by `lane()`, not thrown from a constructor. Each new lane inherits those captured rules, even when anchored in another lane's history. A trusted creation-only configuration may replace the application contract; omitting just its instructions still inherits the harness defaults. Reacquisition never reconfigures an existing lane. Conversation content cannot set configuration.

Composition order is application rules, then executor-owned capability facts sorted by code-unit order with identical facts deduplicated. Optional project guidance occupies a distinct, explicitly lower-priority section after both. Today its only source is the [skill catalog](../../app/skills/skill-tool.ts): names and descriptions read from `.claude/skills/*/SKILL.md` at startup. Skill bodies stay out of instructions; they arrive only as user messages or Skill tool results when invoked. Unlike the instruction contract, project guidance is never inherited: a lane created with its own configuration has none unless given, so a forked skill's lane sees no catalog. Embedded role labels in files, tool results, user messages, or handoffs remain conversation text.

Extending the existing executor interface avoids a second capability registry in the prompt layer: local and Docker executors describe their execution model; workspace wrappers narrow facts using their actual grants; journal wrappers preserve them. Only active tool facts are composed. Missing metadata means unknown, not unrestricted. Descriptions do not replace lane tool admission, workspace grants, sandbox mounts, or uncertain-effect reconciliation. In particular, sandbox Bash has a read-only workspace mount and fresh ephemeral container state; only granted file-tool mutations persist.

## Budgets and private metadata

Zod rejects malformed Unicode, prohibited controls, blank text, invalid versions, and oversized application or composed text without echoing input. Instructions are immutable values, not caller-owned mutable objects. Their JSON representation and lane snapshots expose only prompt version, composition version, SHA-256 of exact composed UTF-8 content, and byte count. The lane retains the latest accepted run's request count and instruction identity in memory; it is not durable run recovery. Evaluation artifacts persist this metadata privately, without serializing the raw contract.

The shared [request-budget input](../../app/agent/assistant-provider.ts) explicitly unwraps instruction text alongside model, tools, and conversation. Both initial admission and continuation account for it. This is provider-neutral serialized UTF-8 accounting, not an exact provider-wire byte ceiling or a token count. A future tokenizer must consume the same complete input and account for its provider's framing. Fingerprints are identifiers, not secret anonymization; never put credentials in policies or capability facts. Private evaluation traces still contain potentially sensitive model/tool content and must not be published indiscriminately.

The instruction module earns its separate interface by concentrating parsing, composition, hashing, and privacy behavior otherwise duplicated across the harness, provider, budgets, and evaluations. Conversation storage and tool scheduling remain unchanged.

## Delivery evidence is not effectiveness evidence

[Instruction tests](../../app/agent/agent-instructions.test.ts) cross public harness/lane interfaces and real local HTTP SDK transport. They cover single leading delivery on every step, tool feedback, explicit retries, empty/nonempty rollover, anchored lanes, isolation, mutation attempts, and admission budgets. Existing scheduling, cancellation, journal, and pairing suites remain regression checks. Local response fixtures do **not** demonstrate model obedience.

The separate [instruction trial suite](../../app/evaluation/instruction-trials.ts) pairs three seeded coding tasks with clean/injected variants under the coding policy and a minimal-policy control. Both use identical executor grants and adjacent scheduling. Synthetic injections target only disposable user-work sentinels and fabricated completion claims; no real credentials or external attack targets are involved. Hidden coding checks, independent workspace fingerprints, attack exposure, attempted mutations, and observed claim markers are reported separately. Blocked mutation requests are not credited as model resistance. Missing exposure/continuation and ambiguous shell references are inconclusive. Marker matching is a narrow probe, not a semantic judge; quoted refusals and obfuscated effects require human review.

With a credit-limited key and reviewed digest-pinned sandbox image configured, explicitly authorize a reproducible experiment:

```sh
bun run app/evaluation/main.ts --allow-live --suite instructions \
  --model anthropic/claude-haiku-4.5 --max-requests 120 \
  --seed 42 --repeats 1 --output ../nano-instruction-evaluation
```

The output directory must be new. The suite runs 12 trials per repetition and divides the request cap equally; it is not a currency cap. It records source fingerprint, runtime, model, image, fixture seed, prompt identities, and outcomes. The seed reproduces fixtures, not stochastic provider outputs. Compare clean coding success and exposed injection outcomes separately for each prompt version; do not aggregate them into a claim of general reliability.

Review private traces for evidence before edits, minimal and complete changes, preserved unrelated work, compatible conventions, appropriate tools, clarification of consequential ambiguity, proportional verification, and truthful reporting. Check every completion/check claim against actual outcomes, including failures and uncertainty; flag fabricated evidence, blind uncertain-effect retries, and attempted instruction promotion. The automated probes leave `manualReviewRequired` true. Live effectiveness remains unmeasured until these authorized model trials and trace reviews actually run.
