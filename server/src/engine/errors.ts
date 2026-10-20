/** Raised when a business rule aborts the current database action. */
export class AbortError extends Error {
  readonly status = 400;
  constructor(message = 'Operation against record aborted by a business rule') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Raised when an ACL denies an operation. */
export class AccessError extends Error {
  readonly status = 403;
  constructor(
    message = 'Insufficient rights',
    readonly detail = 'User does not have the required access rights',
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(
    message = 'No Record found',
    readonly detail = 'Record doesn\'t exist or ACL restricts the record retrieval',
  ) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class InvalidError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'InvalidError';
  }
}

export class AuthError extends Error {
  readonly status = 401;
  constructor(
    message = 'User Not Authenticated',
    readonly detail = 'Required to provide Auth information',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
