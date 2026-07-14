/**
 * Exponential backoff with full jitter.
 *
 * The jitter is not cosmetic, and it is the part everyone leaves out.
 *
 * Without it, every client that failed at the same moment retries at the same moment. A server that
 * comes back from a 30-second outage is hit by its entire client base in lockstep, falls over again,
 * and the fleet re-synchronises even harder on the next attempt. That is a self-inflicted DDoS, and
 * it is *caused* by the retry logic that was supposed to make the system resilient.
 *
 * Full jitter (`random(0, cap)`) rather than "exponential ± 20%" — it spreads the retries across the
 * entire window, which is what actually flattens the thundering herd. AWS published the arithmetic on
 * this a decade ago and it is still the correct answer.
 */

export interface BackoffConfig {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 500,
  maxMs: 30_000,
  /**
   * After 8 attempts (~2 minutes of trying, with jitter), an operation goes to the dead-letter queue.
   *
   * Retrying forever is not resilience — it is a client that will burn a user's battery for three
   * days pushing an operation the server has been rejecting since Tuesday. A bounded retry that ends
   * in a *visible* failure is strictly more honest than an unbounded one that ends in silence.
   */
  maxAttempts: 8,
};

/**
 * Delay before attempt `attempt` (0-indexed: attempt 0 is the first retry).
 *
 * `random` is injectable so the test can assert the bounds deterministically. A backoff function that
 * calls Math.random() directly is a backoff function nobody can write a real test for.
 */
export function backoffDelay(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(config.maxMs, config.baseMs * 2 ** attempt);
  return Math.floor(random() * exponential);
}

export function shouldRetry(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF): boolean {
  return attempt < config.maxAttempts;
}

/**
 * Is this failure worth retrying at all?
 *
 * The server tells us — every error response carries an explicit `retryable` flag, because the server
 * is the only thing that knows whether the request could ever succeed. Getting this wrong in either
 * direction is expensive:
 *
 *   - treating a 422 as retryable ⇒ the client hammers the server forever with an operation that is
 *     malformed and always will be;
 *   - treating a 503 as permanent ⇒ the client dead-letters a user's writes because of a deploy.
 *
 * When the server said nothing (a network error, a CORS failure, a dead DNS), we assume retryable:
 * the request never arrived, so nothing about it is known to be wrong.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof SyncHttpError) return error.retryable;
  // A TypeError from fetch() means the request never left the machine. That is the offline case, and
  // it is the single most common "failure" in this product's life. It is always retryable.
  return true;
}

export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable: boolean,
    retryAfterSeconds?: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }
}
