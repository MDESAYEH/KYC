export class DuplicateKycCaseError extends Error {
  constructor(
    readonly kycRefNo: string,
    readonly reisSystemId: string,
  ) {
    super('A KYC case already exists for this kycRefNo or reisSystemId');
    this.name = 'DuplicateKycCaseError';
  }
}

export class KycCaseNotFoundError extends Error {
  constructor(readonly internalId: string) {
    super(`KYC case not found: ${internalId}`);
    this.name = 'KycCaseNotFoundError';
  }
}

/** Attaching a different CUSTOMER_NO to a case that already has one. */
export class CustomerNoConflictError extends Error {
  constructor(
    readonly internalId: string,
    readonly existing: string,
    readonly attempted: string,
  ) {
    super(`KYC case ${internalId} already has a different CUSTOMER_NO`);
    this.name = 'CustomerNoConflictError';
  }
}

export class UnsupportedDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDatabaseError';
  }
}
