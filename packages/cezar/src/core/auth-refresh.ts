/**
 * Claude Code's transient OAuth refresh failure.
 *
 * When the access token has expired, the CLI refreshes it under a lock shared by every Claude Code
 * process of the account. If that lock is held, or a holder exited mid-refresh, the CLI gives up at
 * once with an `is_error` result and tells the user to retry in a minute. It is not a usage limit
 * (nothing is exhausted, there is no reset instant) and not a revoked token (signing in again is not
 * needed): the same step started a minute later works. On 2026-10-02 it failed four scheduled
 * housekeeping runs whose first agent step happened to start right after the token expired.
 *
 * Deliberately matches the CLI's exact sentence, not "OAuth" or "refresh" in general: a revoked or
 * invalid token must still fail the run on the first attempt.
 */
const AUTH_REFRESH_RE = /failed to refresh oauth token: another claude code process is refreshing it/i;

/** How long to wait before the one retry: the CLI's own "retry in a minute". */
export const AUTH_REFRESH_RETRY_DELAY_MS = 60_000;

export function isTransientAuthRefreshFailure(message: string | undefined): boolean {
  return !!message && AUTH_REFRESH_RE.test(message);
}
