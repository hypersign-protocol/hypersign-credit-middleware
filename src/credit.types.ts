/** Injection token for the Redis client supplied by the host application. */
export const CREDIT_REDIS_CLIENT = 'REDIS_CLIENT';
export const CREDIT_OPTIONS = 'CREDIT_OPTIONS';

/** The subset of the ioredis/node-redis legacy eval API used by this POC. */
export interface CreditRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

export interface ReserveCreditInput {
  accountId: string;
  requestId?: string;
  serviceId?: string;
  amount: number;
}

export interface ReserveCreditResult {
  reservationId: string;
  remainingBalance: number;
  expiresAt: number;
  existing: boolean;
}

export type CreditReservationStatus =
  | 'RESERVED'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'EXPIRED';

export interface CreditReservation {
  reservationId: string;
  accountId: string;
  requestId?: string;
  serviceId?: string;
  amount: number;
  remainingBalance: number;
  status: CreditReservationStatus;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
  finalizedAt?: number;
  finalizationReason?: string;
}

export interface CreditOptions {
  /** How long a request owns a reservation without renewal. Default: 60s. */
  leaseMs?: number;
  /** How long finalized audit records and request mappings remain. Default: 7d. */
  retentionMs?: number;
  /** Maximum expired reservations processed per recovery pass. Default: 100. */
  recoveryBatchSize?: number;
}

export interface ResolvedCreditOptions {
  leaseMs: number;
  retentionMs: number;
  recoveryBatchSize: number;
}
