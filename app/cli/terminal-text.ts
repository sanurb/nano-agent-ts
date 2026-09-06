// C0 except tab/LF, DEL/C1, and Unicode bidi embeddings/overrides/isolates.
// Keep these protocol ranges as character escapes rather than opaque decimal comparisons.
// oxlint-disable-next-line no-control-regex -- Matching these controls is intentional: render them visibly instead of executing them.
const terminalControlPattern = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const hexadecimalRadix = 16;
const unicodeEscapeDigits = 4;

/** Render untrusted text without allowing terminal control sequences or hidden direction overrides to act. */
export function renderTerminalText(text: string): string {
  return text.replace(terminalControlPattern, (character) =>
    `\\u${character.charCodeAt(0).toString(hexadecimalRadix).padStart(unicodeEscapeDigits, "0")}`);
}
