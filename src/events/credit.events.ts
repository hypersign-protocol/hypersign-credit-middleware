import { CreditSettlementMode, CreditSubject } from '../credit.types';

/** All event type identifiers emitted by this SDK. */
export type CreditEventType =
  | 'RESERVED'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'EXPIRED'
  | 'CREDIT_GRANTED'
  | 'CRITICAL_BALANCE'
  | 'BALANCE_INITIALIZED';

/** Fields present on every credit event. */
export interface BaseCreditEvent {
  /** The specific event that occurred. */
  type: CreditEventType;
  /** Unix epoch milliseconds when the event was created. */
  timestamp: number;
  /** Complete wallet identity whose balance was affected. */
  subject: CreditSubject;
  /** Convenience fields for logs and stream consumers. */
  accountId: string;
  tenantId?: string;
  accountType?: string;
  serviceId?: string;
  creditType?: string;
  scopeId: string;
}

/** Emitted after a credit reservation is successfully created in Redis. */
export interface CreditReservedEvent extends BaseCreditEvent {
  type: 'RESERVED';
  reservationId: string;
  requestId?: string;
  /** Number of credits reserved. */
  amount: number;
  /** Scoped wallet balance after this reservation. */
  balanceAfter: number;
  /** Unix epoch milliseconds when the lease expires if never settled. */
  expiresAt: number;
  /** Whether scheduled recovery may refund this reservation after expiry. */
  autoRecover: boolean;
  settlementMode: CreditSettlementMode;
  operation?: string;
}

/**
 * Emitted after a reservation is committed (the API call succeeded and the
 * credit deduction is permanent).
 */
export interface CreditCommittedEvent extends BaseCreditEvent {
  type: 'COMMITTED';
  reservationId: string;
  /** Number of credits that were permanently deducted. */
  amount: number;
  /** Scoped wallet balance after the original reservation deduction. */
  balanceAfter: number;
  operation?: string;
}

/**
 * Emitted after a reservation is rolled back (the API call failed and credits
 * were refunded to the account).
 */
export interface CreditRolledBackEvent extends BaseCreditEvent {
  type: 'ROLLED_BACK';
  reservationId: string;
  /** Number of credits refunded. */
  amount: number;
  /** Human-readable reason supplied by the caller or the interceptor. */
  reason: string;
  /** Scoped wallet balance after the refund. */
  balanceAfter: number;
  operation?: string;
}

/**
 * Emitted by CreditRecoveryService when it finds and refunds a reservation
 * whose lease expired without being settled (e.g. process crash).
 */
export interface CreditExpiredEvent extends BaseCreditEvent {
  type: 'EXPIRED';
  reservationId: string;
  /** Number of credits refunded by the recovery pass. */
  amount: number;
  /** Scoped wallet balance after recovery refunded the reservation. */
  balanceAfter: number;
  operation?: string;
}

/** Emitted after an idempotent credit top-up changes a scoped wallet. */
export interface CreditGrantedEvent extends BaseCreditEvent {
  type: 'CREDIT_GRANTED';
  referenceId: string;
  amount: number;
  balanceAfter: number;
  reason?: string;
}

/**
 * Emitted when the remaining balance is at or below the configured
 * `criticalBalance` threshold after any reserve operation. Use this
 * to send low-balance alerts or trigger a top-up workflow.
 */
export interface CreditCriticalBalanceEvent extends BaseCreditEvent {
  type: 'CRITICAL_BALANCE';
  /** Current balance after the operation that triggered this alert. */
  balance: number;
  /** The configured threshold that was breached. */
  threshold: number;
}

/**
 * Emitted when the SDK consults the authoritative `balanceProvider` and
 * writes a fresh balance into Redis.
 */
export interface CreditBalanceInitializedEvent extends BaseCreditEvent {
  type: 'BALANCE_INITIALIZED';
  /** The balance value written to Redis from the provider. */
  balance: number;
  /** Opaque tag from the provider snapshot, e.g. "timescaledb". */
  source?: string;
  revision?: string;
}

/** Discriminated union of all events the SDK can emit. */
export type AnyCreditEvent =
  | CreditReservedEvent
  | CreditCommittedEvent
  | CreditRolledBackEvent
  | CreditExpiredEvent
  | CreditGrantedEvent
  | CreditCriticalBalanceEvent
  | CreditBalanceInitializedEvent;
