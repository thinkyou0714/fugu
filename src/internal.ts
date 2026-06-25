/**
 * Internal runtime helpers shared across modules. Intentionally NOT part of the
 * public API — these are deliberately absent from the `src/index.ts` barrel.
 * Zero-dependency and erasable (plain functions only).
 */

/** Safe property read: returns `obj[key]` when `obj` is a non-null object, else undefined. */
export function getProp(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Best-effort message from an unknown thrown value, without assuming it is an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coerce an unknown thrown value into an Error (Errors pass through unchanged). */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Read the Fugu request id from response headers (canonical + legacy spelling). */
export function requestIdFrom(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? headers.get("x-requestid") ?? undefined;
}
