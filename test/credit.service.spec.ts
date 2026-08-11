import {
  COMMIT_SCRIPT,
  CreditService,
  FIND_EXPIRED_SCRIPT,
  InsufficientCreditsException,
  RECOVER_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  ROLLBACK_SCRIPT,
} from '../src/credit.service';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import { CreditRedisClient } from '../src/credit.types';

class InMemoryRedis implements CreditRedisClient {
  readonly balances = new Map<string, number>();
  readonly reservations = new Map<string, Record<string, string>>();
  readonly requests = new Map<string, Record<string, string>>();
  readonly expirations = new Map<string, number>();

  async eval(script: string, keyCount: number, ...args: Array<string | number>) {
    const keys = args.slice(0, keyCount).map(String);
    const argv = args.slice(keyCount).map(String);
    if (script === RESERVE_SCRIPT) {
      const existing = this.requests.get(keys[2]);
      if (existing) return [existing.reservationId, existing.remainingBalance,
        existing.expiresAt, 1];
      const balance = this.balances.get(keys[0]) ?? 0;
      const amount = Number(argv[0]);
      if (balance < amount) return [-1];
      const remaining = balance - amount;
      const expiresAt = Number(argv[5]) + Number(argv[6]);
      this.balances.set(keys[0], remaining);
      this.reservations.set(keys[1], {
        reservationId: argv[1], accountId: argv[2], requestId: argv[3],
        serviceId: argv[4], amount: argv[0], remainingBalance: String(remaining),
        status: 'RESERVED', ownerId: argv[7], createdAt: argv[5],
        expiresAt: String(expiresAt), version: '1',
      });
      this.requests.set(keys[2], {
        reservationId: argv[1], remainingBalance: String(remaining),
        expiresAt: String(expiresAt),
      });
      this.expirations.set(argv[1], expiresAt);
      return [argv[1], remaining, expiresAt, 0];
    }
    if (script === COMMIT_SCRIPT) {
      const reservation = this.reservations.get(keys[0]);
      if (!reservation) return -2;
      if (reservation.status === 'COMMITTED') return 0;
      if (reservation.status !== 'RESERVED') return -1;
      reservation.status = 'COMMITTED';
      reservation.finalizedAt = argv[0];
      reservation.finalizationReason = 'controller_succeeded';
      this.expirations.delete(argv[1]);
      return 1;
    }
    if (script === ROLLBACK_SCRIPT) {
      const reservation = this.reservations.get(keys[0]);
      if (!reservation || reservation.status !== 'RESERVED') return 0;
      const balanceKey = `${argv[0]}${reservation.accountId}`;
      this.balances.set(balanceKey,
        (this.balances.get(balanceKey) ?? 0) + Number(reservation.amount));
      reservation.status = argv[1];
      reservation.finalizedAt = argv[2];
      reservation.finalizationReason = argv[3];
      this.expirations.delete(argv[4]);
      return 1;
    }
    if (script === RENEW_SCRIPT) {
      const reservation = this.reservations.get(keys[0]);
      if (!reservation || reservation.status !== 'RESERVED') return -1;
      if (reservation.ownerId !== argv[0]) return -2;
      const expiresAt = Number(argv[1]) + Number(argv[2]);
      reservation.expiresAt = String(expiresAt);
      this.expirations.set(argv[3], expiresAt);
      return expiresAt;
    }
    if (script === FIND_EXPIRED_SCRIPT) {
      return [...this.expirations.entries()]
        .filter(([, expiresAt]) => expiresAt <= Number(argv[0]))
        .slice(0, Number(argv[1])).map(([id]) => id);
    }
    if (script === RECOVER_SCRIPT) {
      const reservation = this.reservations.get(keys[0]);
      if (!reservation || reservation.status !== 'RESERVED' ||
          Number(reservation.expiresAt) > Number(argv[0])) return 0;
      const balanceKey = `${argv[1]}${reservation.accountId}`;
      this.balances.set(balanceKey,
        (this.balances.get(balanceKey) ?? 0) + Number(reservation.amount));
      reservation.status = 'EXPIRED';
      reservation.finalizedAt = argv[0];
      reservation.finalizationReason = 'lease_expired';
      this.expirations.delete(argv[2]);
      return 1;
    }
    if (script.includes('HGETALL')) {
      const value = this.reservations.get(keys[0]);
      return value ? Object.entries(value).flat() : [];
    }
    return this.balances.get(keys[0])?.toString() ?? '0';
  }
}

describe('CreditService', () => {
  let redis: InMemoryRedis;
  let service: CreditService;

  beforeEach(() => {
    redis = new InMemoryRedis();
    service = new CreditService(redis, { ...DEFAULT_CREDIT_OPTIONS, leaseMs: 1_000 });
  });

  it('retains a committed audit record without refunding', async () => {
    redis.balances.set('credit:balance:user_123', 100);
    const reservation = await service.reserve({
      accountId: 'user_123', requestId: 'req_1', amount: 20,
    });
    expect(reservation.remainingBalance).toBe(80);
    expect(await service.commit(reservation.reservationId)).toBe(true);
    expect(await service.commit(reservation.reservationId)).toBe(false);
    expect((await service.getReservation(reservation.reservationId))?.status)
      .toBe('COMMITTED');
    expect(await service.getBalance('user_123')).toBe(80);
  });

  it('rolls back exactly once and retains the audit state', async () => {
    redis.balances.set('credit:balance:user_123', 100);
    const { reservationId } = await service.reserve({ accountId: 'user_123', amount: 20 });
    expect(await service.rollback(reservationId)).toBe(true);
    expect(await service.rollback(reservationId)).toBe(false);
    expect((await service.getReservation(reservationId))?.status).toBe('ROLLED_BACK');
    expect(await service.getBalance('user_123')).toBe(100);
  });

  it('returns the same reservation for a duplicate request ID', async () => {
    redis.balances.set('credit:balance:user_123', 100);
    const input = { accountId: 'user_123', requestId: 'same-request', amount: 20 };
    const [first, second] = await Promise.all([service.reserve(input), service.reserve(input)]);
    expect(second.reservationId).toBe(first.reservationId);
    expect([first.existing, second.existing].sort()).toEqual([false, true]);
    expect(await service.getBalance('user_123')).toBe(80);
  });

  it('rejects insufficient credit without creating a reservation', async () => {
    redis.balances.set('credit:balance:user_123', 10);
    await expect(service.reserve({ accountId: 'user_123', amount: 20 }))
      .rejects.toBeInstanceOf(InsufficientCreditsException);
    expect(await service.getBalance('user_123')).toBe(10);
    expect(redis.reservations.size).toBe(0);
  });

  it('allows only one of two concurrent 70-credit reservations', async () => {
    redis.balances.set('credit:balance:user_123', 100);
    const results = await Promise.allSettled([
      service.reserve({ accountId: 'user_123', requestId: 'a', amount: 70 }),
      service.reserve({ accountId: 'user_123', requestId: 'b', amount: 70 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await service.getBalance('user_123')).toBe(30);
  });

  it('recovers an expired lease exactly once', async () => {
    redis.balances.set('credit:balance:user_123', 100);
    const reservation = await service.reserve({ accountId: 'user_123', amount: 20 });
    expect(await service.recoverExpired(reservation.expiresAt + 1)).toBe(1);
    expect(await service.recoverExpired(reservation.expiresAt + 1)).toBe(0);
    expect(await service.getBalance('user_123')).toBe(100);
    expect((await service.getReservation(reservation.reservationId))?.status).toBe('EXPIRED');
  });
});
