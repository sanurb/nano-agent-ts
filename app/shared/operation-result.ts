/** Expected failures are values; promise rejection is reserved for defects. */
export type OperationResult<Value, Failure extends Error> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };
