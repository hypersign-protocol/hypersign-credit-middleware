import {
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
} from '@nestjs/common';
import { CreditModuleEventHandler } from './events/credit.event-handler';

/** Injection token for the Redis client supplied by the host application. */
export const CREDIT_REDIS_CLIENT = 'REDIS_CLIENT';
export const CREDIT_OPTIONS = 'CREDIT_OPTIONS';

/** The subset of the ioredis/node-redis legacy eval API used by this SDK. */
export interface CreditRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

export type CreditSettlementMode = 'IMMEDIATE' | 'DEFERRED';
export type CreditAccountType = 'USER' | 'BUSINESS' | 'SERVICE' | string;

/**
 * Uniquely identifies the wallet from which credits are deducted.
 * `accountId` alone is sufficient for a global wallet. Add dimensions only
 * when balances are genuinely independent across those dimensions.
 */
export interface CreditSubject {
  accountId: string;
  tenantId?: string;
  accountType?: CreditAccountType;
  serviceId?: string;
  creditType?: string;
}

export interface CreditBalanceSnapshot {
  balance: number;
  /** Opaque tag identifying the data source, e.g. "billing-ledger". */
  source?: string;
  /** Optional authoritative ledger revision used for auditing. */
  revision?: string;
}

/**
 * Loads an initial balance only when the scoped Redis balance key is absent.
 * It is never called merely because a balance is low or insufficient, which
 * prevents a stale provider snapshot from recreating already-spent credits.
 */
export interface CreditBalanceProvider {
  getBalance(subject: CreditSubject): Promise<CreditBalanceSnapshot>;
}

export interface CreditRequestContext {
  subject: CreditSubject;
  requestId?: string;
}

export interface EarlyCreditPolicy {
  method: string;
  path: string;
  amount: number;
  settlementMode?: CreditSettlementMode;
  operation?: string;
}

export interface ReserveCreditInput {
  subject: CreditSubject;
  requestId?: string;
  amount: number;
  settlementMode?: CreditSettlementMode;
  operation?: string;
  /**
   * When false, scheduled recovery never refunds this reservation merely
   * because its lease elapsed. It must be explicitly committed or rolled back.
   * Defaults to true.
   */
  autoRecover?: boolean;
}

export interface ReserveCreditResult {
  reservationId: string;
  /** Required to renew a long-running deferred reservation from any worker. */
  leaseToken: string;
  scopeId: string;
  remainingBalance: number;
  expiresAt: number;
  autoRecover: boolean;
  existing: boolean;
  settlementMode: CreditSettlementMode;
  subject: CreditSubject;
}

export interface GrantCreditsInput {
  subject: CreditSubject;
  amount: number;
  /** Globally stable business transaction ID; deduplicated for `retentionMs`. */
  referenceId: string;
  reason?: string;
}

export interface GrantCreditsResult {
  balance: number;
  existing: boolean;
  subject: CreditSubject;
}

export type CreditReservationStatus =
  | 'RESERVED'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'EXPIRED';

export interface CreditReservation extends CreditSubject {
  subject: CreditSubject;
  reservationId: string;
  scopeId: string;
  requestId?: string;
  amount: number;
  remainingBalance: number;
  status: CreditReservationStatus;
  createdAt: number;
  expiresAt: number;
  autoRecover: boolean;
  finalizedAt?: number;
  finalizationReason?: string;
  settlementMode: CreditSettlementMode;
  operation?: string;
  /** Incremented by CreditService.renew(); starts at 1 on creation. */
  version: number;
}

export interface CreditOptions {
  /** How long a request owns a reservation without renewal. Default: 60s. */
  leaseMs?: number;
  /** How long finalized audit records and request mappings remain. Default: 7d. */
  retentionMs?: number;
  /** Maximum expired reservations processed per recovery pass. Default: 100. */
  recoveryBatchSize?: number;
  /** Low-balance notification threshold. It never triggers replenishment. */
  criticalBalance?: number | ((subject: CreditSubject) => number);
  /** Initial balance source, consulted only when the scoped Redis key is absent. */
  balanceProvider?: CreditBalanceProvider;
  /** How long to hold the initialization stampede lock. Default: 5s. */
  initializationLockMs?: number;
  /** Redis key prefix. Default: "credit". */
  keyPrefix?: string;
  /**
   * Redis Cluster hash tag. All Lua keys share this slot. Default: "credit".
   * A single tag favors correctness; shard separate SDK deployments when needed.
   */
  redisHashTag?: string;
  /** Approximate maximum entries kept in the audit stream. Default: 100000. */
  eventStreamMaxLength?: number;
  /** Maximum best-effort in-process handler events waiting to run. Default: 1000. */
  eventHandlerQueueSize?: number;
  eventHandler?: CreditModuleEventHandler;
  earlyPolicies?: EarlyCreditPolicy[];
  /** Resolves a trusted, authenticated billing subject for every request. */
  requestContextResolver?: (request: unknown) => CreditRequestContext;
}

export interface ResolvedCreditOptions {
  leaseMs: number;
  retentionMs: number;
  recoveryBatchSize: number;
  criticalBalance: number | ((subject: CreditSubject) => number);
  balanceProvider?: CreditBalanceProvider;
  initializationLockMs: number;
  keyPrefix: string;
  redisHashTag: string;
  eventStreamKey: string;
  eventStreamMaxLength: number;
  eventHandlerQueueSize: number;
  eventHandler?: CreditModuleEventHandler;
  earlyPolicies: EarlyCreditPolicy[];
  requestContextResolver: (request: unknown) => CreditRequestContext;
}

export interface CreditModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: any[]) => CreditOptions | Promise<CreditOptions>;
}
