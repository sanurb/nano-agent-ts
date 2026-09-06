import { expect, test } from "bun:test";
import fc from "fast-check";
import { renderTerminalText } from "./terminal-text.ts";

test("terminal rendering preserves ordinary Unicode, tabs, newlines, and literal escape text", () => {
  const text = "Hello, 世界 😀\n\tRésumé \\u001b";
  expect(renderTerminalText(text)).toBe(text);
});

test.each([
  ["\u001b[2J", "\\u001b[2J"],
  ["\r\b\u0000\u0007", "\\u000d\\u0008\\u0000\\u0007"],
  ["\u007f\u0085\u009b\u009f", "\\u007f\\u0085\\u009b\\u009f"],
  ["a\u202eb\u202c\u2066c\u2069", "a\\u202eb\\u202c\\u2066c\\u2069"],
])("terminal controls become visible text: %j", (input, expected) => {
  expect(renderTerminalText(input)).toBe(expected);
});

test("rendering is idempotent across arbitrary UTF-16 text", () => {
  const text = fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 100 }).map((codes) => String.fromCharCode(...codes));
  fc.assert(fc.property(text, (input) => {
    const rendered = renderTerminalText(input);
    expect(renderTerminalText(rendered)).toBe(rendered);
  }));
});
