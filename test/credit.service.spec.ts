import { DEFAULT_CREDIT_OPTIONS, GET_BALANCE_SCRIPT, GET_RESERVATION_SCRIPT } from '../src/credit.constants';
import { CreditKeyspace } from '../src/credit-keyspace';
import {
  ACQUIRE_LOCK_SCRIPT,
  COMMIT_SCRIPT,
  CreditService,
  FIND_EXPIRED_SCRIPT,
  GRANT_SCRIPT,
  INITIALIZE_BALANCE_SCRIPT,
  InsufficientCreditsException,
  RECOVER_SCRIPT,
  REMOVE_EXPIRATION_SCRIPT,
  RELEASE_LOCK_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  ROLLBACK_SCRIPT,
} from '../src/credit.service';
import { CreditRedisClient, CreditSubject } from '../src/credit.types';

class InMemoryRedis implements CreditRedisClient {
  readonly strings = new Map<string, string>();
  readonly reservations = new Map<string, Record<string, string>>();
  readonly requests = new Map<string, Record<string, string>>();
  readonly expirations = new Map<string, number>();

  async eval(script: string, keyCount: number, ...args: Array<string | number>) {
    const keys = args.slice(0, keyCount).map(String);
    const argv = args.slice(keyCount).map(String);
    if (script === GET_BALANCE_SCRIPT) return this.strings.get(keys[0]) ?? null;
    if (script === GET_RESERVATION_SCRIPT) {
      const value = this.reservations.get(keys[0]);
      return value ? Object.entries(value).flat() : [];
    }
    if (script === ACQUIRE_LOCK_SCRIPT) {
      if (this.strings.has(keys[0])) return 0;
      this.strings.set(keys[0], argv[0]);
      return 1;
    }
    if (script === RELEASE_LOCK_SCRIPT) {
      if (this.strings.get(keys[0]) !== argv[0]) return 0;
      this.strings.delete(keys[0]);
      return 1;
    }
    if (script === INITIALIZE_BALANCE_SCRIPT) {
      if (this.strings.has(keys[0])) return 0;
      this.strings.set(keys[0], argv[0]);
      return 1;
    }
    if (script === GRANT_SCRIPT) {
      const existing = this.requests.get(keys[1]);
      if (existing) {
        if (existing.amount !== argv[0]) return [-1];
        if (!this.strings.has(keys[0])) return [-2];
        return [this.strings.get(keys[0])!, 1];
      }
      if (!this.strings.has(keys[0])) return [-2];
      const balance = Number(this.strings.get(keys[0])) + Number(argv[0]);
      this.strings.set(keys[0], String(balance));
      this.requests.set(keys[1], { amount: argv[0], balance: String(balance) });
      return [balance, 0];
    }
    if (script === RESERVE_SCRIPT) {
      const existing = this.requests.get(keys[2]);
      if (existing) {
        if (existing.amount !== argv[0] || existing.settlementMode !== argv[13] ||
            existing.operation !== argv[14] || existing.autoRecover !== argv[15]) return [-2];
        return [existing.reservationId, existing.remainingBalance, existing.expiresAt, 1,
          existing.leaseToken, existing.autoRecover];
      }
      if (!this.strings.has(keys[0])) return [-3];
      const balance = Number(this.strings.get(keys[0]));
      const amount = Number(argv[0]);
      if (balance < amount) return [-1];
      const remaining = balance - amount;
      const expiresAt = Number(argv[9]) + Number(argv[10]);
      this.strings.set(keys[0], String(remaining));
      this.reservations.set(keys[1], {
        reservationId: argv[1], scopeId: argv[2], accountId: argv[3],
        tenantId: argv[4], accountType: argv[5], serviceId: argv[6],
        creditType: argv[7], requestId: argv[8], amount: argv[0],
        remainingBalance: String(remaining), status: 'RESERVED', leaseToken: argv[11],
        createdAt: argv[9], expiresAt: String(expiresAt), version: '1',
        settlementMode: argv[13], operation: argv[14], autoRecover: argv[15],
        balanceKey: keys[0],
      });
      this.requests.set(keys[2], {
        reservationId: argv[1], remainingBalance: String(remaining),
        expiresAt: String(expiresAt), amount: argv[0],
        settlementMode: argv[13], operation: argv[14], leaseToken: argv[11],
        autoRecover: argv[15],
      });
      if (argv[15] === '1') this.expirations.set(argv[1], expiresAt);
      return [argv[1], remaining, expiresAt, 0, argv[11], argv[15]];
    }
    if (script === COMMIT_SCRIPT) {
      const reservation = this.reservations.get(keys[0]);
      if (!reservation) return [-2];
      if (reservation.status === 'COMMITTED') return [0];
      if (reservation.status !== 'RESERVED') return [-1];
      reservation.status = 'COMMITTED';
      reservation.finalizedAt = argv[0];
      reservation.finalizationReason = 'controller_succeeded';
      this.expirations.delete(argv[1]);
      return [1, ...this.fields(reservation), reservation.remainingBalance];
    }
    if (script === ROLLBACK_SCRIPT) {
      const reservation = this.reservations.get(keys[0]);
      if (!reservation || reservation.status !== 'RESERVED') return [0];
      if (reservation.balanceKey !== keys[3]) return [-2];
      const remaining = Number(this.strings.get(keys[3])) + Number(reservation.amount);
      this.strings.set(keys[3], String(remaining));
      reservation.status = argv[0];
      reservation.finalizedAt = argv[1];
      reservation.finalizationReason = argv[2];
      reservation.remainingBalance = String(remaining);
      this.expirations.delete(argv[3]);
      return [1, ...this.fields(reservation), remaining];
    }
    if (script === RENEW_SCRIPT) {
      const reservation = this.reservations.get(keys[0]);
      if (!reservation || reservation.status !== 'RESERVED') return -1;
      if (reservation.leaseToken !== argv[0]) return -2;
      const expiresAt = Number(argv[1]) + Number(argv[2]);
      reservation.expiresAt = String(expiresAt);
      reservation.version = String(Number(reservation.version) + 1);
      if (reservation.autoRecover !== '0') {
        this.expirations.set(argv[3], expiresAt);
      }
      return expiresAt;
    }
    if (script === FIND_EXPIRED_SCRIPT) {
      return [...this.expirations.entries()]
        .filter(([, expiresAt]) => expiresAt <= Number(argv[0]))
        .slice(0, Number(argv[1])).map(([id]) => id);
    }
    if (script === REMOVE_EXPIRATION_SCRIPT) {
      return this.expirations.delete(argv[0]) ? 1 : 0;
    }
    if (script === RECOVER_SCRIPT) {
      const reservation = this.reservations.get(keys[0]);
      if (!reservation || reservation.status !== 'RESERVED') {
        this.expirations.delete(argv[1]);
        return [0];
      }
      if (Number(reservation.expiresAt) > Number(argv[0])) return [0];
      if (reservation.autoRecover === '0') {
        this.expirations.delete(argv[1]);
        return [0];
      }
      if (reservation.balanceKey !== keys[3]) return [-2];
      const remaining = Number(this.strings.get(keys[3])) + Number(reservation.amount);
      this.strings.set(keys[3], String(remaining));
      reservation.status = 'EXPIRED';
      reservation.finalizedAt = argv[0];
      reservation.finalizationReason = 'lease_expired';
      reservation.remainingBalance = String(remaining);
      this.expirations.delete(argv[1]);
      return [1, ...this.fields(reservation), remaining];
    }
    throw new Error('Unsupported script in test Redis');
  }

  private fields(value: Record<string, string>) {
    return [value.scopeId, value.accountId, value.tenantId, value.accountType,
      value.serviceId, value.creditType, value.amount, value.operation];
  }
}

const userA: CreditSubject = {
  tenantId: 'tenant_1', accountType: 'USER', accountId: 'user_a',
  serviceId: 'kyc', creditType: 'API_CREDIT',
};
const userB: CreditSubject = { ...userA, accountId: 'user_b' };

describe('CreditService production invariants', () => {
  let redis: InMemoryRedis;
  let service: CreditService;
  let keys: CreditKeyspace;

  beforeEach(() => {
    redis = new InMemoryRedis();
    const options = { ...DEFAULT_CREDIT_OPTIONS, leaseMs: 1_000 };
    keys = new CreditKeyspace(options);
    service = new CreditService(redis, options);
  });

  const seed = (subject: CreditSubject, amount: number) =>
    redis.strings.set(keys.balance(subject), String(amount));

  it('deducts and commits only the selected account wallet', async () => {
    service = new CreditService(redis, { ...DEFAULT_CREDIT_OPTIONS, leaseMs: 1_000 });
    seed(userA, 100);
    seed(userB, 55);
    const reservation = await service.reserve({
      subject: userA, requestId: 'req_1', amount: 20,
    });
    expect(reservation.remainingBalance).toBe(80);
    expect(await service.commit(reservation.reservationId)).toBe(true);
    expect(await service.getBalance(userA)).toBe(80);
    expect(await service.getBalance(userB)).toBe(55);
  });

  it('isolates the same account across tenant, service, and credit type', async () => {
    const otherTenant = { ...userA, tenantId: 'tenant_2' };
    const otherService = { ...userA, serviceId: 'ssi' };
    const otherCreditType = { ...userA, creditType: 'STORAGE_CREDIT' };
    for (const subject of [userA, otherTenant, otherService, otherCreditType]) seed(subject, 100);
    await service.reserve({ subject: otherService, amount: 10 });
    expect(await service.getBalance(userA)).toBe(100);
    expect(await service.getBalance(otherTenant)).toBe(100);
    expect(await service.getBalance(otherService)).toBe(90);
    expect(await service.getBalance(otherCreditType)).toBe(100);
  });

  it('does not collide omitted dimensions with sentinel-like real values', () => {
    const omitted: CreditSubject = { accountId: 'same' };
    const underscore: CreditSubject = {
      accountId: 'same', tenantId: '_', accountType: '_', serviceId: '_',
    };
    const defaultCredit: CreditSubject = {
      accountId: 'same', creditType: 'default',
    };

    expect(keys.scopeId(omitted)).not.toBe(keys.scopeId(underscore));
    expect(keys.scopeId(omitted)).not.toBe(keys.scopeId(defaultCredit));
  });

  it('rolls back exactly once to the original scoped wallet', async () => {
    seed(userA, 100);
    const { reservationId } = await service.reserve({ subject: userA, amount: 20 });
    expect(await service.rollback(reservationId)).toBe(true);
    expect(await service.rollback(reservationId)).toBe(false);
    expect(await service.getBalance(userA)).toBe(100);
    expect((await service.getReservation(reservationId))?.status).toBe('ROLLED_BACK');
  });

  it('records exact rollback fields without positional corruption', async () => {
    seed(userA, 100);
    const { reservationId } = await service.reserve({
      subject: userA, amount: 20, operation: 'VERIFY_KYC',
    });
    await service.rollback(reservationId, 'verification_failed');
    expect(await service.getReservation(reservationId)).toEqual(expect.objectContaining({
      status: 'ROLLED_BACK', amount: 20, operation: 'VERIFY_KYC',
      finalizationReason: 'verification_failed', remainingBalance: 100,
      subject: userA,
    }));
  });

  it('never calls the provider to replenish an existing insufficient balance', async () => {
    seed(userA, 5);
    const provider = { getBalance: jest.fn().mockResolvedValue({ balance: 100 }) };
    service = new CreditService(
      redis, { ...DEFAULT_CREDIT_OPTIONS, criticalBalance: 20, balanceProvider: provider },
    );
    await expect(service.reserve({ subject: userA, amount: 10 }))
      .rejects.toBeInstanceOf(InsufficientCreditsException);
    expect(provider.getBalance).not.toHaveBeenCalled();
    expect(await service.getBalance(userA)).toBe(5);
  });

  it('does not mutate Redis when a dynamic critical threshold is invalid', async () => {
    seed(userA, 100);
    service = new CreditService(
      redis,
      { ...DEFAULT_CREDIT_OPTIONS, criticalBalance: () => -1 },
    );

    await expect(service.reserve({ subject: userA, amount: 20 }))
      .rejects.toThrow('criticalBalance');
    expect(await service.getBalance(userA)).toBe(100);
    expect(redis.reservations.size).toBe(0);
  });

  it('initializes a missing wallet from the exact subject once', async () => {
    const provider = { getBalance: jest.fn().mockResolvedValue({ balance: 40, source: 'ledger' }) };
    service = new CreditService(
      redis, { ...DEFAULT_CREDIT_OPTIONS, balanceProvider: provider },
    );
    await service.reserve({ subject: userA, requestId: 'first', amount: 10 });
    await service.reserve({ subject: userA, requestId: 'second', amount: 10 });
    expect(provider.getBalance).toHaveBeenCalledTimes(1);
    expect(provider.getBalance).toHaveBeenCalledWith(userA);
    expect(await service.getBalance(userA)).toBe(20);
  });

  it('returns the same reservation for the same scoped request ID', async () => {
    seed(userA, 100);
    const input = { subject: userA, requestId: 'same-request', amount: 20 };
    const first = await service.reserve(input);
    const second = await service.reserve(input);
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.existing).toBe(true);
    expect(await service.getBalance(userA)).toBe(80);
  });

  it('does not apply duplicate mutations for idempotent retries', async () => {
    seed(userA, 100);
    const reservationInput = {
      subject: userA, requestId: 'retry-request', amount: 20,
    };
    const firstReservation = await service.reserve(reservationInput);
    const retryReservation = await service.reserve(reservationInput);
    const grantInput = {
      subject: userA, amount: 10, referenceId: 'retry-payment',
    };
    const firstGrant = await service.grant(grantInput);
    const retryGrant = await service.grant(grantInput);

    expect(retryReservation).toMatchObject({
      reservationId: firstReservation.reservationId, existing: true,
    });
    expect(firstGrant.existing).toBe(false);
    expect(retryGrant.existing).toBe(true);
    expect(await service.getBalance(userA)).toBe(90);
  });

  it('grants credits once for an idempotent business reference', async () => {
    seed(userA, 10);
    const first = await service.grant({
      subject: userA, amount: 25, referenceId: 'payment_123', reason: 'purchase',
    });
    const retry = await service.grant({
      subject: userA, amount: 25, referenceId: 'payment_123', reason: 'purchase',
    });
    expect(first).toMatchObject({ balance: 35, existing: false });
    expect(retry).toMatchObject({ balance: 35, existing: true });
    expect(await service.getBalance(userA)).toBe(35);
  });

  it('adds a grant to available balance while a reservation is active', async () => {
    seed(userA, 100);
    const reservation = await service.reserve({ subject: userA, amount: 20 });

    await expect(service.grant({
      subject: userA,
      amount: 50,
      referenceId: 'recharge_during_reservation',
    })).resolves.toMatchObject({ balance: 130, existing: false });

    await expect(service.commit(reservation.reservationId)).resolves.toBe(true);
    expect(await service.getBalance(userA)).toBe(130);
  });

  it('preserves a grant when an active reservation is rolled back', async () => {
    seed(userA, 100);
    const reservation = await service.reserve({ subject: userA, amount: 20 });

    await service.grant({
      subject: userA,
      amount: 50,
      referenceId: 'recharge_before_rollback',
    });
    await expect(service.rollback(reservation.reservationId, 'failed'))
      .resolves.toBe(true);

    expect(await service.getBalance(userA)).toBe(150);
  });

  it('returns the current balance when a grant is retried after spending', async () => {
    seed(userA, 100);
    await service.grant({
      subject: userA,
      amount: 50,
      referenceId: 'recharge_then_spend',
    });
    await service.reserve({ subject: userA, amount: 20 });

    await expect(service.grant({
      subject: userA,
      amount: 50,
      referenceId: 'recharge_then_spend',
    })).resolves.toMatchObject({ balance: 130, existing: true });
    expect(await service.getBalance(userA)).toBe(130);
  });

  it('recovers an expired reservation exactly once', async () => {
    seed(userA, 100);
    const reservation = await service.reserve({ subject: userA, amount: 20 });
    const recovered = await service.recoverExpired(reservation.expiresAt + 1);
    expect(recovered).toEqual([expect.objectContaining({
      accountId: 'user_a', amount: 20, balanceAfter: 100,
    })]);
    expect(await service.recoverExpired(reservation.expiresAt + 1)).toHaveLength(0);
    expect(await service.getBalance(userA)).toBe(100);
    expect((await service.getReservation(reservation.reservationId))?.status).toBe('EXPIRED');
  });

  it('removes a dangling expiration entry so it cannot starve recovery', async () => {
    redis.expirations.set('missing-reservation', 1);

    await expect(service.recoverExpired(2)).resolves.toEqual([]);
    expect(redis.expirations.has('missing-reservation')).toBe(false);
  });

  it('does not automatically recover a manually settled reservation', async () => {
    seed(userA, 100);
    const reservation = await service.reserve({
      subject: userA,
      amount: 20,
      settlementMode: 'DEFERRED',
      autoRecover: false,
    });

    expect(reservation.autoRecover).toBe(false);
    expect(await service.recoverExpired(reservation.expiresAt + 1)).toHaveLength(0);
    expect(await service.getBalance(userA)).toBe(80);
    expect((await service.getReservation(reservation.reservationId))?.status)
      .toBe('RESERVED');

    await expect(service.rollback(reservation.reservationId, 'downstream_failed'))
      .resolves.toBe(true);
    expect(await service.getBalance(userA)).toBe(100);
  });

  it('allows disabling recovery only for deferred reservations', async () => {
    seed(userA, 100);
    await expect(service.reserve({
      subject: userA,
      amount: 20,
      settlementMode: 'IMMEDIATE',
      autoRecover: false,
    })).rejects.toThrow('only for DEFERRED reservations');
    expect(await service.getBalance(userA)).toBe(100);
  });

  it('renews a deferred lease only with its capability token', async () => {
    seed(userA, 100);
    const reservation = await service.reserve({
      subject: userA, amount: 20, settlementMode: 'DEFERRED',
    });
    await expect(service.renew(reservation.reservationId, 'wrong-token'))
      .rejects.toThrow('cannot be renewed');
    const renewedExpiry = await service.renew(
      reservation.reservationId, reservation.leaseToken,
    );
    expect(renewedExpiry).toBeGreaterThanOrEqual(reservation.expiresAt);
  });

  it('uses one Redis Cluster hash tag for every transactional key', () => {
    const allKeys = [keys.balance(userA), keys.request(userA, 'req'),
      keys.reservation('res'), keys.expirations(), keys.eventStream()];
    expect(allKeys.every((key) => key.includes('{credit}'))).toBe(true);
  });
});
