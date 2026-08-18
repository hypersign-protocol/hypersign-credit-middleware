import { CreditSettlementMode, CreditSubject } from '../credit.types';

/** All event type identifiers emitted by this SDK. */
export type CreditEventType =
  | 'RESERVED'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'EXPIRED'
  | 'PLAN_EXPIRED'
  | 'CREDIT_GRANTED'
  | 'CRITICAL_BALANCE';

/** Fields present on every credit event. */
export interface BaseCreditEvent {
  /** The specific event that occurred. */
  type: CreditEventType;
  /** Unix epoch milliseconds when the event was created. */
  timestamp: number;
  /** Complete wallet identity whose balance was affected. */
  subject: CreditSubject;
  /** Convenience fields for logs and stream consumers. */
  appId: string;
  tenantId?: string;
  appType?: string;
  creditType?: string;
  scopeId: string;
  /** Present on every plan-affecting event. */
  planId?: string;
}

/** Emitted after a credit reservation is successfully created in Redis. */
export interface CreditReservedEvent extends BaseCreditEvent {
  type: 'RESERVED';
  planId: string;
  reservationId: string;
  requestId?: string;
  /** Number reserved from this event's plan. */
  amount: number;
  totalAmount: number;
  /** Scoped wallet balance after this reservation. */
  balanceAfter: number;
  planBalanceAfter: number;
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
  planId: string;
  reservationId: string;
  /** Number of credits that were permanently deducted. */
  amount: number;
  totalAmount: number;
  allocationIndex: number;
  allocationCount: number;
  /** Scoped wallet balance after the original reservation deduction. */
  balanceAfter: number;
  planBalanceAfter: number;
  operation?: string;
}

/**
 * Emitted after a reservation is rolled back (the API call failed and credits
 * were refunded to the account).
 */
export interface CreditRolledBackEvent extends BaseCreditEvent {
  type: 'ROLLED_BACK';
  planId: string;
  reservationId: string;
  /** Number of credits refunded. */
  amount: number;
  restoredAmount: number;
  expiredAmount: number;
  /** Human-readable reason supplied by the caller or the interceptor. */
  reason: string;
  /** Scoped wallet balance after the refund. */
  balanceAfter: number;
  planBalanceAfter: number;
  operation?: string;
}

/**
 * Emitted by CreditRecoveryService when it finds and refunds a reservation
 * whose lease expired without being settled (e.g. process crash).
 */
export interface CreditExpiredEvent extends BaseCreditEvent {
  type: 'EXPIRED';
  planId: string;
  reservationId: string;
  /** Number of credits refunded by the recovery pass. */
  amount: number;
  restoredAmount: number;
  expiredAmount: number;
  /** Scoped wallet balance after recovery refunded the reservation. */
  balanceAfter: number;
  planBalanceAfter: number;
  operation?: string;
}

/** Emitted after an idempotent credit top-up changes a scoped wallet. */
export interface CreditGrantedEvent extends BaseCreditEvent {
  type: 'CREDIT_GRANTED';
  planId: string;
  referenceId: string;
  amount: number;
  balanceAfter: number;
  planBalanceAfter: number;
  grantedAt: number;
  expiresAt: number;
  reason?: string;
}

export interface CreditPlanExpiredEvent extends BaseCreditEvent {
  type: 'PLAN_EXPIRED';
  planId: string;
  expiredAmount: number;
  expiresAt: number;
  balanceAfter: number;
  planBalanceAfter: 0;
}

/**
 * Emitted when the remaining balance is at or below the configured
 * `criticalBalance` threshold after any reserve operation. Use this
 * to send low-balance alerts or trigger a top-up workflow.
 */
export interface CreditCriticalBalanceEvent extends BaseCreditEvent {
  type: 'CRITICAL_BALANCE';
  planId: string;
  /** Current balance after the operation that triggered this alert. */
  balance: number;
  /** The configured threshold that was breached. */
  threshold: number;
}

/** Discriminated union of all events the SDK can emit. */
export type AnyCreditEvent =
  | CreditReservedEvent
  | CreditCommittedEvent
  | CreditRolledBackEvent
  | CreditExpiredEvent
  | CreditPlanExpiredEvent
  | CreditGrantedEvent
  | CreditCriticalBalanceEvent;
