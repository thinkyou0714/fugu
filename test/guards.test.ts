import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isFuguError,
  isRetryable,
  isAuthError,
  isPermissionError,
  isRateLimitError,
  isTimeoutError,
  FuguAuthError,
  FuguPermissionError,
  FuguRateLimitError,
  FuguTimeoutError,
  FuguConnectionError,
  FuguBadRequestError,
  FuguAPIError,
} from "../src/errors.ts";

test("isFuguError is true for any FuguError, false otherwise", () => {
  assert.equal(isFuguError(new FuguAuthError("x")), true);
  assert.equal(isFuguError(new Error("x")), false);
  assert.equal(isFuguError("nope"), false);
  assert.equal(isFuguError(null), false);
  assert.equal(isFuguError(undefined), false);
});

test("class guards narrow by exact error type", () => {
  assert.equal(isAuthError(new FuguAuthError("x")), true);
  assert.equal(isAuthError(new FuguPermissionError("x")), false);
  assert.equal(isPermissionError(new FuguPermissionError("x")), true);
  assert.equal(isRateLimitError(new FuguRateLimitError("x")), true);
  assert.equal(isTimeoutError(new FuguTimeoutError("x")), true);
  assert.equal(isTimeoutError(new FuguAuthError("x")), false);
  assert.equal(isAuthError(new Error("x")), false);
});

test("isRetryable mirrors FuguError.isRetryable (timeout/connection/rate_limit/5xx)", () => {
  assert.equal(isRetryable(new FuguTimeoutError("x")), true);
  assert.equal(isRetryable(new FuguConnectionError("x")), true);
  assert.equal(isRetryable(new FuguRateLimitError("x")), true);
  assert.equal(isRetryable(new FuguAPIError("x", { status: 503 })), true);
  assert.equal(isRetryable(new FuguAPIError("x", { status: 418 })), false);
  assert.equal(isRetryable(new FuguAuthError("x")), false);
  assert.equal(isRetryable(new FuguBadRequestError("x")), false);
  assert.equal(isRetryable(new Error("x")), false);
});
