// Errors raised by the portal adapter. The API layer maps these to HTTP
// responses, so callers never see raw portal behaviour.

export class PortalError extends Error {
  constructor(message, { code = 'portal_error', cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** Login was rejected — almost certainly a configuration problem on our side. */
export class PortalAuthError extends PortalError {
  constructor(message, opts) {
    super(message, { code: 'portal_auth_failed', ...opts });
  }
}

/** The portal says the thing does not exist. */
export class PortalNotFoundError extends PortalError {
  constructor(message, opts) {
    super(message, { code: 'not_found', ...opts });
  }
}

/** We could not get a request through the portal's rate limit within our wait budget. */
export class PortalRateLimitedError extends PortalError {
  constructor(message, { retryAfterSeconds = 30, ...opts } = {}) {
    super(message, { code: 'portal_rate_limited', ...opts });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Network failure, timeout, 5xx or an unexpected response shape. */
export class PortalUnavailableError extends PortalError {
  constructor(message, opts) {
    super(message, { code: 'portal_unavailable', ...opts });
  }
}
