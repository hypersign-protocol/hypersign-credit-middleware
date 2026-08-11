import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BALANCE_PREFIX,
  EXPIRATION_KEY,
  REQUEST_PREFIX,
  RESERVATION_PREFIX,
} from './credit.constants';
import {
  CREDIT_OPTIONS,
  CREDIT_REDIS_CLIENT,
  CreditOptions,
  CreditRedisClient,
  CreditReservation,
  CreditReservationStatus,
  ReserveCreditInput,
  ReserveCreditResult,
  ResolvedCreditOptions,
} from './credit.types';

const RESERVE_SCRIPT = `
local existingId = redis.call('HGET', KEYS[3], 'reservationId')
if existingId then
  return {existingId, redis.call('HGET', KEYS[3], 'remainingBalance'),
    redis.call('HGET', KEYS[3], 'expiresAt'), 1}
end
local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if balance < amount then return {-1} end
local now = tonumber(ARGV[6])
local expiresAt = now + tonumber(ARGV[7])
local remaining = redis.call('DECRBY', KEYS[1], amount)
redis.call('HSET', KEYS[2], 'reservationId', ARGV[2], 'accountId', ARGV[3],
  'requestId', ARGV[4], 'serviceId', ARGV[5], 'amount', amount,
  'remainingBalance', remaining, 'status', 'RESERVED', 'ownerId', ARGV[8],
  'createdAt', now, 'expiresAt', expiresAt, 'version', 1)
redis.call('ZADD', KEYS[4], expiresAt, ARGV[2])
redis.call('HSET', KEYS[3], 'reservationId', ARGV[2],
  'remainingBalance', remaining, 'expiresAt', expiresAt)
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[9]))
return {ARGV[2], remaining, expiresAt, 0}
`;

const COMMIT_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return -2 end
if status == 'COMMITTED' then return 0 end
if status ~= 'RESERVED' then return -1 end
redis.call('HSET', KEYS[1], 'status', 'COMMITTED', 'finalizedAt', ARGV[1],
  'finalizationReason', 'controller_succeeded')
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`;

const ROLLBACK_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return -2 end
if status ~= 'RESERVED' then return 0 end
local accountId = redis.call('HGET', KEYS[1], 'accountId')
local amount = redis.call('HGET', KEYS[1], 'amount')
redis.call('INCRBY', ARGV[1] .. accountId, amount)
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'finalizedAt', ARGV[3],
  'finalizationReason', ARGV[4])
redis.call('ZREM', KEYS[2], ARGV[5])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[6]))
return 1
`;

const RENEW_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'RESERVED' then return -1 end
if redis.call('HGET', KEYS[1], 'ownerId') ~= ARGV[1] then return -2 end
local expiresAt = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], 'expiresAt', expiresAt)
redis.call('HINCRBY', KEYS[1], 'version', 1)
redis.call('ZADD', KEYS[2], expiresAt, ARGV[4])
return expiresAt
`;

const FIND_EXPIRED_SCRIPT = `
return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1],
  'LIMIT', 0, tonumber(ARGV[2]))
`;

const RECOVER_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'RESERVED' then return 0 end
local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if expiresAt > tonumber(ARGV[1]) then return 0 end
local accountId = redis.call('HGET', KEYS[1], 'accountId')
local amount = redis.call('HGET', KEYS[1], 'amount')
redis.call('INCRBY', ARGV[2] .. accountId, amount)
redis.call('HSET', KEYS[1], 'status', 'EXPIRED', 'finalizedAt', ARGV[1],
  'finalizationReason', 'lease_expired')
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

export class InsufficientCreditsException extends BadRequestException {
  constructor() { super('Insufficient credits'); }
}

@Injectable()
export class CreditService {
  private readonly ownerId = randomUUID();

  constructor(
    @Inject(CREDIT_REDIS_CLIENT) private readonly redis: CreditRedisClient,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
  ) {}

  async reserve(input: ReserveCreditInput): Promise<ReserveCreditResult> {
    if (!input.accountId) throw new TypeError('accountId is required');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new TypeError('amount must be a positive safe integer');
    }
    const reservationId = randomUUID();
    const requestId = input.requestId || randomUUID();
    const now = Date.now();
    const result = await this.redis.eval(RESERVE_SCRIPT, 4,
      this.balanceKey(input.accountId), this.reservationKey(reservationId),
      this.requestKey(input.accountId, requestId), EXPIRATION_KEY,
      input.amount, reservationId, input.accountId, requestId,
      input.serviceId ?? '', now, this.options.leaseMs, this.ownerId,
      this.options.retentionMs,
    );
    const values = result as Array<string | number>;
    if (Number(values[0]) === -1) throw new InsufficientCreditsException();
    if (!Array.isArray(values) || values.length !== 4) {
      throw new Error(`Unexpected Redis reserve result: ${String(result)}`);
    }
    return {
      reservationId: String(values[0]),
      remainingBalance: Number(values[1]),
      expiresAt: Number(values[2]),
      existing: Number(values[3]) === 1,
    };
  }

  async commit(reservationId: string): Promise<boolean> {
    const result = await this.redis.eval(COMMIT_SCRIPT, 2,
      this.reservationKey(reservationId), EXPIRATION_KEY,
      Date.now(), reservationId, this.options.retentionMs,
    );
    return Number(result) === 1;
  }

  async rollback(reservationId: string, reason = 'controller_failed'): Promise<boolean> {
    return this.finalizeWithRefund(reservationId, 'ROLLED_BACK', reason);
  }

  async renew(reservationId: string): Promise<number> {
    const result = Number(await this.redis.eval(RENEW_SCRIPT, 2,
      this.reservationKey(reservationId), EXPIRATION_KEY,
      this.ownerId, Date.now(), this.options.leaseMs, reservationId,
    ));
    if (result < 0) throw new Error(`Reservation ${reservationId} cannot be renewed`);
    return result;
  }

  async recoverExpired(now = Date.now()): Promise<number> {
    const ids = await this.redis.eval(FIND_EXPIRED_SCRIPT, 1, EXPIRATION_KEY,
      now, this.options.recoveryBatchSize) as string[];
    let recovered = 0;
    for (const id of ids) {
      const result = await this.redis.eval(RECOVER_SCRIPT, 2,
        this.reservationKey(id), EXPIRATION_KEY,
        now, BALANCE_PREFIX, id, this.options.retentionMs,
      );
      if (Number(result) === 1) recovered++;
    }
    return recovered;
  }

  async getReservation(reservationId: string): Promise<CreditReservation | null> {
    const result = await this.redis.eval(
      "return redis.call('HGETALL', KEYS[1])", 1,
      this.reservationKey(reservationId),
    ) as string[];
    if (!result.length) return null;
    const data: Record<string, string> = {};
    for (let index = 0; index < result.length; index += 2) {
      data[result[index]] = result[index + 1];
    }
    return {
      reservationId: data.reservationId,
      accountId: data.accountId,
      requestId: data.requestId || undefined,
      serviceId: data.serviceId || undefined,
      amount: Number(data.amount),
      remainingBalance: Number(data.remainingBalance),
      status: data.status as CreditReservationStatus,
      ownerId: data.ownerId,
      createdAt: Number(data.createdAt),
      expiresAt: Number(data.expiresAt),
      finalizedAt: data.finalizedAt ? Number(data.finalizedAt) : undefined,
      finalizationReason: data.finalizationReason,
    };
  }

  async getBalance(accountId: string): Promise<number> {
    return Number(await this.redis.eval(
      "return redis.call('GET', KEYS[1]) or '0'", 1,
      this.balanceKey(accountId),
    ));
  }

  private async finalizeWithRefund(
    reservationId: string,
    status: 'ROLLED_BACK' | 'EXPIRED',
    reason: string,
  ): Promise<boolean> {
    const result = await this.redis.eval(ROLLBACK_SCRIPT, 2,
      this.reservationKey(reservationId), EXPIRATION_KEY,
      BALANCE_PREFIX, status, Date.now(), reason, reservationId,
      this.options.retentionMs,
    );
    return Number(result) === 1;
  }

  private balanceKey(accountId: string) { return `${BALANCE_PREFIX}${accountId}`; }
  private reservationKey(id: string) { return `${RESERVATION_PREFIX}${id}`; }
  private requestKey(accountId: string, requestId: string) {
    return `${REQUEST_PREFIX}${accountId}:${requestId}`;
  }
}

export {
  COMMIT_SCRIPT,
  FIND_EXPIRED_SCRIPT,
  RECOVER_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  ROLLBACK_SCRIPT,
};
