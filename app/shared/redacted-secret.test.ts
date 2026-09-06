import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { RedactedSecret } from "./redacted-secret.ts";

test("secret values are hidden from string, JSON, Node and Bun inspection", () => {
  const secret = new RedactedSecret("never-log-this-credential");
  expect(String(secret)).toBe("[REDACTED]");
  expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
  expect(inspect(secret)).toBe("[REDACTED]");
  expect(Bun.inspect(secret)).toBe("[REDACTED]");
  expect(secret.reveal()).toBe("never-log-this-credential");
});
