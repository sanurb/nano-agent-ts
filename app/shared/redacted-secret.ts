/** A credential that stays redacted during string, JSON, and console inspection. */
export class RedactedSecret {
  readonly #value: string;

  /** Wrap a secret at ingress; only the outbound authentication owner may reveal it. */
  constructor(value: string) {
    this.#value = value;
  }

  /** Reveal the credential only when constructing the authenticated provider client. */
  reveal(): string {
    return this.#value;
  }

  /** String conversion never exposes the credential. */
  toString(): string {
    return "[REDACTED]";
  }

  /** JSON serialization never exposes the credential. */
  toJSON(): string {
    return "[REDACTED]";
  }

  /** Node and Bun console inspection never exposes the credential. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[REDACTED]";
  }
}
