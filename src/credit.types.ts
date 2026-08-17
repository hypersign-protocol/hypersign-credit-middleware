import {
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
} from '@nestjs/common';

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

/** Dedicated Redis connection used only for blocking Stream consumption. */
export interface CreditEventStreamClient {
  xgroup(...args: any[]): Promise<unknown>;
  xreadgroup(...args: any[]): Promise<unknown>;
  xautoclaim(...args: any[]): Promise<unknown>;
  xack(...args: any[]): Promise<unknown>;
}

export interface CreditBullMqJob {
  id?: string;
  name: string;
  data: unknown;
}

export interface CreditBullMqWorker {
  close(): Promise<void>;
}

/** Structural adapter implemented by the host using its BullMQ connections. */
export interface CreditBullMqProvider {
  add(
    queueName: string,
    jobName: string,
    data: unknown,
    options: { jobId: string },
  ): Promise<unknown>;
  createWorker(
    queueName: string,
    processor: (job: CreditBullMqJob) => Promise<unknown>,
  ): Promise<CreditBullMqWorker>;
}

export interface CreditCommandEnvelope {
  commandId: string;
  schemaVersion: 1;
  serviceId: string;
  requestedAt?: string;
  source?: string;
  payload: Record<string, unknown>;
}

export interface CreditBullMqOptions {
  provider: CreditBullMqProvider;
  /** Must not be the connection used by CreditService. */
  streamClient: CreditEventStreamClient;
  lifecycleQueueNames?: string[];
  commandQueueName?: string;
  consumerGroup?: string;
  batchSize?: number;
  blockMs?: number;
  pendingIdleMs?: number;
}

export interface ResolvedCreditBullMqOptions extends CreditBullMqOptions {
  lifecycleQueueNames: string[];
  consumerGroup: string;
  batchSize: number;
  blockMs: number;
  pendingIdleMs: number;
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

export interface CreditCatalogCharge {
  /** Unique within one route; also scopes request idempotency. */
  id: string;
  creditType: string;
  amount: number;
  settlementMode?: CreditSettlementMode;
  autoRecover?: boolean;
}

export interface CreditCatalogRoute {
  method: string;
  path: string;
  /** Defaults to the canonical "METHOD /full/path". */
  operation?: string;
  /** Reserve before later application middleware; trusted identity must exist. */
  boundary?: boolean;
  /** An empty array explicitly declares a free endpoint. */
  charges: CreditCatalogCharge[];
}

export interface CreditCatalog {
  serviceId: string;
  version: string;
  globalPrefix?: string;
  /** URI inserts v<version> into the route; NONE covers header/media/custom versioning. */
  versioning?: 'URI' | 'NONE';
  uriVersionPrefix?: string;
  /** Version applied by Nest when a controller or handler has no @Version metadata. */
  defaultVersion?: string;
  routes: CreditCatalogRoute[];
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
  /** Required, authoritative route and pricing catalog for this service. */
  catalog?: CreditCatalog;
  /** Optional durable BullMQ egress and trusted command ingress. */
  bullMq?: CreditBullMqOptions;
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
  /** Resolves a trusted, authenticated billing subject for every request. */
  requestContextResolver?: (request: unknown) => CreditRequestContext;
}

export interface ResolvedCreditOptions {
  catalog: CreditCatalog;
  bullMq?: ResolvedCreditBullMqOptions;
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
  requestContextResolver: (request: unknown) => CreditRequestContext;
}

export interface CreditModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: any[]) => CreditOptions | Promise<CreditOptions>;
}
