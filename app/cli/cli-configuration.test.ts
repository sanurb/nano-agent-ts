import { expect, test } from "bun:test";
import { parseCliConfiguration } from "./cli-configuration.ts";

test("CLI configuration defaults to OpenRouter without modifying prompt whitespace", () => {
  const result = parseCliConfiguration(["-p", "  hello\n  "], {
    apiKey: "test-key",
    baseURL: undefined,
  });
  if (!result.ok) throw result.error;
  expect(result.value.baseURL).toBe("https://openrouter.ai/api/v1");
  expect(result.value.prompt).toBe("  hello\n  ");
  expect(result.value.apiKey.reveal()).toBe("test-key");
});
