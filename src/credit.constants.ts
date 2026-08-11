import { ResolvedCreditOptions } from './credit.types';

export const BALANCE_PREFIX = 'credit:balance:';
export const RESERVATION_PREFIX = 'credit:reservation:';
export const REQUEST_PREFIX = 'credit:request:';
export const EXPIRATION_KEY = 'credit:reservation:expirations';

export const DEFAULT_CREDIT_OPTIONS: ResolvedCreditOptions = {
  leaseMs: 60_000,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  recoveryBatchSize: 100,
};
