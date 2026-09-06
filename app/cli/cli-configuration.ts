import { z } from "zod";
import type { OperationResult } from "../shared/operation-result.ts";
import { RedactedSecret } from "../shared/redacted-secret.ts";

const providerURLSchema = z.url({ protocol: /^https?$/ });

/** Only the environment values consumed by this CLI; read them once in the entrypoint. */
export interface CliEnvironment {
  readonly apiKey: string | undefined;
  readonly baseURL: string | undefined;
}

/** Parsed startup values; never log this configuration or reveal its API key. */
export interface CliConfiguration {
  readonly prompt: string;
  readonly apiKey: RedactedSecret;
  readonly baseURL: string;
}

/** A startup rejection with a safe diagnostic that contains no supplied values. */
export class CliConfigurationError extends Error {
  /** Stable classification for startup failures. */
  readonly _tag = "CliConfigurationError" as const;

  /** Retain the existing missing-key and missing-prompt diagnostics. */
  constructor(readonly reason: "missing_api_key" | "missing_prompt" | "invalid_base_url") {
    super(
      reason === "missing_api_key"
        ? "OPENROUTER_API_KEY is not set"
        : reason === "missing_prompt"
          ? "error: -p flag is required"
          : "Invalid OPENROUTER_BASE_URL: expected an HTTP or HTTPS URL",
    );
  }
}

/** Parse arguments after the executable/script; retain prompt whitespace and ignore trailing args. */
export function parseCliConfiguration(
  args: readonly string[],
  environment: CliEnvironment,
): OperationResult<CliConfiguration, CliConfigurationError> {
  if (!environment.apiKey) {
    return { ok: false, error: new CliConfigurationError("missing_api_key") };
  }
  const [flag, prompt] = args;
  if (flag !== "-p" || !prompt) {
    return { ok: false, error: new CliConfigurationError("missing_prompt") };
  }
  const baseURL = environment.baseURL ?? "https://openrouter.ai/api/v1";
  if (!providerURLSchema.safeParse(baseURL).success) {
    return { ok: false, error: new CliConfigurationError("invalid_base_url") };
  }
  return {
    ok: true,
    value: { prompt, apiKey: new RedactedSecret(environment.apiKey), baseURL },
  };
}
