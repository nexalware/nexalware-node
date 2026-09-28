/**
 * Thrown for any non-2xx response from the Nexalware API. Mirrors the
 * platform's own error envelope (`{ error, message?, details? }`) so
 * callers get the same reason a dashboard user or curl call would see,
 * not a generic HTTP failure.
 */
export class NexalwareApiError extends Error {
  readonly status: number;
  readonly error: string;
  readonly details?: unknown[];

  constructor(status: number, body: { error?: string; message?: string; details?: unknown[] }) {
    super(body.message ?? body.error ?? `Nexalware API request failed with status ${status}`);
    this.name = "NexalwareApiError";
    this.status = status;
    this.error = body.error ?? "UNKNOWN_ERROR";
    this.details = body.details;
  }
}
