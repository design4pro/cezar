import { describe, expect, it } from 'vitest';
import { isTransientAuthRefreshFailure } from './auth-refresh.ts';
import { parseUsageLimit } from './usage-limit.ts';

// The exact text Claude Code 2.1.285 put in the `is_error` result on 2026-10-02.
const REFRESH_FAILURE =
  'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. ' +
  'This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again';

describe('isTransientAuthRefreshFailure', () => {
  it('recognizes the CLI refresh-lock failure', () => {
    expect(isTransientAuthRefreshFailure(REFRESH_FAILURE)).toBe(true);
  });

  it('is not a usage limit', () => {
    expect(parseUsageLimit(REFRESH_FAILURE)).toBeNull();
  });

  it('leaves other auth failures and empty input alone', () => {
    expect(isTransientAuthRefreshFailure('Failed to authenticate. API Error: 401 OAuth access token has been revoked.')).toBe(false);
    expect(isTransientAuthRefreshFailure('Claude AI usage limit reached|1790985603')).toBe(false);
    expect(isTransientAuthRefreshFailure('')).toBe(false);
    expect(isTransientAuthRefreshFailure(undefined)).toBe(false);
  });
});
