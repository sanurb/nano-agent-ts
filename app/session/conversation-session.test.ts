import { expect, test } from "bun:test";
import fc from "fast-check";
import type { AgentMessage } from "../agent/agent-message.ts";
import {
  branchNameSchema,
  ConversationSession,
  type ConversationEntry,
} from "./conversation-session.ts";

interface ExpectedBranch {
  transcript: ConversationEntry[];
  context: AgentMessage[];
}

interface ExpectedBranches {
  main: ExpectedBranch;
  research: ExpectedBranch;
}

const branchOperation = fc.record({
  branch: fc.constantFrom("main", "research"),
  type: fc.constantFrom("message", "context_window"),
  content: fc.string({ maxLength: 100 }),
});

test("generated interleavings preserve shared history, unique global sequence, and lane-local context windows", () => {
  fc.assert(fc.property(fc.array(branchOperation, { maxLength: 120 }), (operations) => {
    let identity = 0;
    const session = new ConversationSession({ next: () => `generated-${++identity}` });
    const main = session.acquireBranch(branchNameSchema.parse("main"), null);
    if (!main.ok) throw main.error;
    main.value.appendMessage({ role: "user", content: "shared root" });
    const research = session.acquireBranch(branchNameSchema.parse("research"), main.value.getTipId());
    if (!research.ok) throw research.error;
    const branches = { main: main.value, research: research.value };
    const expected: ExpectedBranches = {
      main: { transcript: [...main.value.getEntries()], context: [...main.value.getContext()] },
      research: { transcript: [...research.value.getEntries()], context: [...research.value.getContext()] },
    };
    const identities = new Set([main.value.getTipId()]);
    let sequence = 1;
    for (const operation of operations) {
      const branch = branches[operation.branch];
      const model = expected[operation.branch];
      const parentId = model.transcript.at(-1)?.id ?? null;
      if (operation.type === "message") {
        const message = { role: "user", content: operation.content } as const;
        const id = branch.appendMessage(message);
        model.transcript.push({ id, parentId, seq: ++sequence, type: "message", message });
        model.context.push(message);
      } else {
        const id = branch.startContextWindow(operation.content);
        model.transcript.push({ id, parentId, seq: ++sequence, type: "context_window", handoff: operation.content });
        model.context = operation.content === "" ? [] : [{
          role: "user", content: `Context handoff (caller-supplied; verify live state before acting):\n${operation.content}`,
        }];
      }
      const tip = branch.getTipId();
      expect(identities.has(tip)).toBe(false);
      identities.add(tip);
      for (const name of ["main", "research"] as const) {
        expect(branches[name].getEntries()).toEqual(expected[name].transcript);
        expect(branches[name].getContext()).toEqual(expected[name].context);
        expect(branches[name].getTipId()).toBe(expected[name].transcript.at(-1)?.id ?? null);
      }
    }
  }), { numRuns: 100 });
});

test("identity-generator defects cannot partially append or advance the branch tip and sequence", () => {
  const ids = ["first", "first", "second"];
  const session = new ConversationSession({
    next: () => {
      const id = ids.shift();
      if (!id) throw new Error("Identity test exhausted its scripted IDs");
      return id;
    },
  });
  const acquired = session.acquireBranch(branchNameSchema.parse("main"), null);
  if (!acquired.ok) throw acquired.error;
  const branch = acquired.value;
  const firstId = branch.appendMessage({ role: "user", content: "first" });
  expect(() => branch.appendMessage({ role: "user", content: "must not appear" })).toThrow("Session entry ID collision");
  expect(branch.getTipId()).toBe(firstId);
  expect(branch.getEntries()).toHaveLength(1);
  branch.appendMessage({ role: "user", content: "second" });
  expect(branch.getEntries().map((entry) => entry.seq)).toEqual([1, 2]);
  expect(branch.getEntries()[1]?.parentId).toBe(firstId);
});
