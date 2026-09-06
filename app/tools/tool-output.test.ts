import { expect, test } from "bun:test";
import fc from "fast-check";
import { truncateHead, truncateLine } from "./tool-output.ts";

const smallLimits = { maxLines: 3, maxBytes: 1024 };

test("content within both ceilings is returned byte for byte", () => {
  fc.assert(fc.property(fc.string({ maxLength: 200 }), (content) => {
    const truncated = truncateHead(content, { maxLines: 10_000, maxBytes: 10_000 });
    expect(truncated.text).toBe(content);
    expect(truncated.boundBy).toBeNull();
  }), { numRuns: 100 });
});

test("truncated output never ends mid-line", () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 40 }), { maxLength: 60 }), (lines) => {
    const content = lines.join("\n");
    const truncated = truncateHead(content, smallLimits);
    expect(content.startsWith(truncated.text)).toBe(true);
    if (truncated.boundBy !== null) {
      expect(truncated.text.split("\n")).toEqual(content.split("\n").slice(0, truncated.outputLines));
    }
  }), { numRuns: 100 });
});

test("the line ceiling binds when there are many short lines", () => {
  const truncated = truncateHead("a\nb\nc\nd\ne", smallLimits);
  expect(truncated).toMatchObject({ text: "a\nb\nc", boundBy: "lines", outputLines: 3, totalLines: 5 });
});

test("the byte ceiling binds before the line ceiling when lines are long", () => {
  const truncated = truncateHead(["x".repeat(30), "y".repeat(30), "z"].join("\n"), { maxLines: 10, maxBytes: 40 });
  expect(truncated).toMatchObject({ text: "x".repeat(30), boundBy: "bytes", outputLines: 1 });
});

test("a first line over the byte ceiling yields no whole line to show", () => {
  const truncated = truncateHead("x".repeat(100), { maxLines: 10, maxBytes: 40 });
  expect(truncated).toMatchObject({ text: "", outputLines: 0, firstLineExceedsLimit: true });
});

test("multibyte characters are measured in bytes, not code units", () => {
  // Three 4-byte characters exceed a 10-byte ceiling even though the string is 6 code units long.
  expect(truncateHead("🚀🚀🚀", { maxLines: 10, maxBytes: 10 }).firstLineExceedsLimit).toBe(true);
});

test("an overlong single line is elided rather than dropped", () => {
  expect(truncateLine("abcdef", 3)).toBe("abc… [line truncated]");
  expect(truncateLine("abc", 3)).toBe("abc");
});
