import { BadRequestException } from '@nestjs/common';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import {
  CreditBillingMode,
  CreditEnvironment,
  CreditEventType,
  CreditPlanStatus,
  CreditReservationStatus,
} from '../src/credit.enums';
import {
  CreditService,
  InsufficientCreditsException,
} from '../src/credit.service';
import {
  COMMIT_SCRIPT,
  EXPIRE_PLAN_SCRIPT,
  FIND_EXPIRED_PLANS_SCRIPT,
  FIND_EXPIRED_SCRIPT,
  GET_BALANCE_SCRIPT,
  GET_PLANS_SCRIPT,
  GET_RESERVATION_SCRIPT,
  GRANT_SCRIPT,
  OBSERVE_SCRIPT,
  RECOVER_SCRIPT,
  REMOVE_EXPIRATION_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  ROLLBACK_SCRIPT,
} from '../src/credit.scripts';
import { CreditSubject, ObserveCreditInput } from '../src/credit.types';

type Hash = Map<string, string>;

class PlanRedis {
  strings = new Map<string, number>();
  hashes = new Map<string, Hash>();
  zsets = new Map<string, Map<string, number>>();
  events: Array<Record<string, unknown>> = [];

  private hash(key: string): Hash {
    let value = this.hashes.get(key);
    if (!value) { value = new Map(); this.hashes.set(key, value); }
    return value;
  }

  private zset(key: string): Map<string, number> {
    let value = this.zsets.get(key);
    if (!value) { value = new Map(); this.zsets.set(key, value); }
    return value;
  }

  private ordered(key: string): string[] {
    return [...this.zset(key)].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
  }

  async eval(script: string, numberOfKeys: number, ...args: Array<string | number>) {
    const keys = args.slice(0, numberOfKeys).map(String);
    const argv = args.slice(numberOfKeys).map(String);

    if (script === GRANT_SCRIPT) return this.grant(keys, argv);
    if (script === OBSERVE_SCRIPT) return this.observe(keys, argv);
    if (script === RESERVE_SCRIPT) return this.reserve(keys, argv);
    if (script === COMMIT_SCRIPT) return this.commit(keys, argv);
    if (script === ROLLBACK_SCRIPT) return this.refund(keys, argv, false);
    if (script === RECOVER_SCRIPT) return this.refund(keys, argv, true);
    if (script === RENEW_SCRIPT) return this.renew(keys, argv);
    if (script === FIND_EXPIRED_SCRIPT || script === FIND_EXPIRED_PLANS_SCRIPT) {
      return this.ordered(keys[0]).filter((member) =>
        this.zset(keys[0]).get(member)! <= Number(argv[0])).slice(0, Number(argv[1]));
    }
    if (script === REMOVE_EXPIRATION_SCRIPT) return this.zset(keys[0]).delete(argv[0]) ? 1 : 0;
    if (script === EXPIRE_PLAN_SCRIPT) return this.expirePlan(keys, argv);
    if (script === GET_RESERVATION_SCRIPT) {
      return [...(this.hashes.get(keys[0]) ?? new Map())].flat();
    }
    if (script === GET_BALANCE_SCRIPT) {
      if ((this.hashes.get(keys[0])?.size ?? 0) === 0) return null;
      return this.ordered(keys[1]).reduce((sum, planId) =>
        Number(this.hash(keys[3]).get(planId)) > Number(argv[0])
          ? sum + Number(this.hash(keys[2]).get(planId) ?? 0)
          : sum, 0);
    }
    if (script === GET_PLANS_SCRIPT) {
      return JSON.stringify([...this.hash(keys[0]).keys()].map((planId) => ({
        planId,
        grantedAmount: Number(this.hash(keys[0]).get(planId)),
        availableAmount: Number(this.hash(keys[1]).get(planId) ?? 0),
        expiresAt: Number(this.hash(keys[2]).get(planId)),
        grantedAt: Number(this.hash(keys[3]).get(planId)),
        referenceId: this.hash(keys[4]).get(planId),
        status: this.hash(keys[5]).get(planId),
        criticalBalance: Number(this.hash(keys[6]).get(planId)),
      })));
    }
    throw new Error('Unexpected script');
  }

  private grant(keys: string[], argv: string[]) {
    const [planId, amount, grantedAt, expiresAt] = argv;
    let wallet = this.strings.get(keys[0]) ?? 0;
    for (const activePlanId of this.ordered(keys[1])) {
      if (Number(this.hash(keys[4]).get(activePlanId)) <= Number(argv[4])) {
        const unused = Number(this.hash(keys[3]).get(activePlanId) ?? 0);
        wallet -= unused;
        this.hash(keys[3]).set(activePlanId, '0');
        this.hash(keys[7]).set(activePlanId, CreditPlanStatus.EXPIRED);
        this.zset(keys[1]).delete(activePlanId);
        const member = this.hash(keys[8]).get(activePlanId);
        if (member) this.zset(keys[11]).delete(member);
        this.events.push({
          type: CreditEventType.PLAN_EXPIRED,
          planId: activePlanId,
          expiredAmount: unused,
        });
      }
    }
    this.strings.set(keys[0], wallet);
    const existing = this.hash(keys[2]).get(planId);
    if (existing) {
      if (existing !== amount || this.hash(keys[4]).get(planId) !== expiresAt ||
          this.hash(keys[5]).get(planId) !== grantedAt ||
          this.hash(keys[6]).get(planId) !== argv[10] ||
          this.hash(keys[13]).get(planId) !== argv[17]) return [-1];
      return [this.strings.get(keys[0]) ?? 0,
        Number(this.hash(keys[3]).get(planId) ?? 0), 1];
    }
    const ownerScope = this.hash(keys[9]).get('scopeId');
    if (ownerScope && ownerScope !== argv[5]) return [-6];
    const referencePlan = this.hash(keys[10]).get('planId');
    const referenceScope = this.hash(keys[10]).get('scopeId');
    if (referencePlan && (referencePlan !== planId || referenceScope !== argv[5])) return [-2];
    if (referencePlan) return [-7];
    if (Number(expiresAt) <= Number(argv[4])) return [-5];
    if (this.zset(keys[1]).size >= Number(argv[14])) return [-3];
    const balance = (this.strings.get(keys[0]) ?? 0) + Number(amount);
    if (!Number.isSafeInteger(balance)) return [-4];
    this.strings.set(keys[0], balance);
    this.zset(keys[1]).set(planId, Number(grantedAt));
    this.hash(keys[2]).set(planId, amount);
    this.hash(keys[3]).set(planId, amount);
    this.hash(keys[4]).set(planId, expiresAt);
    this.hash(keys[5]).set(planId, grantedAt);
    this.hash(keys[6]).set(planId, argv[10]);
    this.hash(keys[7]).set(planId, CreditPlanStatus.ACTIVE);
    this.hash(keys[8]).set(planId, argv[16]);
    this.hash(keys[13]).set(planId, argv[17]);
    this.hash(keys[9]).set('scopeId', argv[5]);
    this.hash(keys[10]).set('planId', planId);
    this.hash(keys[10]).set('scopeId', argv[5]);
    this.zset(keys[11]).set(argv[16], Number(expiresAt));
    this.events.push({
      type: CreditEventType.CREDIT_GRANTED, planId, amount: Number(amount),
      criticalBalance: Number(argv[17]), balanceAfter: balance,
    });
    return [balance, Number(amount), 0];
  }

  private observe(keys: string[], argv: string[]) {
    const existing = this.hashes.get(keys[0]);
    if (existing?.has('eventId')) {
      if (existing.get('amount') !== argv[9] ||
          existing.get('operation') !== argv[8] ||
          existing.get('environment') !== argv[10]) return [-1];
      return [existing.get('eventId')!, 1];
    }
    const eventId = `${this.events.length + 1}-0`;
    this.hashes.set(keys[0], new Map(Object.entries({
      eventId, amount: argv[9], operation: argv[8], environment: argv[10],
    })));
    this.events.push({
      type: CreditEventType.CREDIT_OBSERVED,
      timestamp: Number(argv[0]), serviceType: argv[1],
      scopeId: argv[2], appId: argv[3], tenantId: argv[4], appType: argv[5],
      creditType: argv[6], requestId: argv[7], operation: argv[8],
      requestedAmount: Number(argv[9]), deductedAmount: 0,
      environment: argv[10], billingMode: CreditBillingMode.OBSERVE, eventId,
    });
    return [eventId, 0];
  }

  private reserve(keys: string[], argv: string[]) {
    const request = this.hashes.get(keys[8]);
    if (request?.has('reservationId')) {
      if (request.get('amount') !== argv[0] || request.get('settlementMode') !== argv[12] ||
          request.get('operation') !== argv[13] || request.get('autoRecover') !== argv[14] ||
          request.get('environment') !== argv[18]) return [-2];
      return [request.get('reservationId')!, request.get('remainingBalance')!,
        request.get('expiresAt')!, 1, request.get('leaseToken')!,
        request.get('autoRecover')!, request.get('allocations')!];
    }
    let wallet = this.strings.get(keys[0]) ?? 0;
    for (const planId of this.ordered(keys[1])) {
      if (Number(this.hash(keys[3]).get(planId)) <= Number(argv[8])) {
        const unused = Number(this.hash(keys[2]).get(planId) ?? 0);
        wallet -= unused;
        this.hash(keys[2]).set(planId, '0');
        this.hash(keys[4]).set(planId, CreditPlanStatus.EXPIRED);
        this.zset(keys[1]).delete(planId);
        const member = this.hash(keys[6]).get(planId);
        if (member) this.zset(keys[10]).delete(member);
        this.events.push({
          type: CreditEventType.PLAN_EXPIRED,
          planId,
          expiredAmount: unused,
        });
      }
    }
    this.strings.set(keys[0], wallet);
    let needed = Number(argv[0]);
    const allocations: Array<{ planId: string; amount: number; planBalanceAfter?: number }> = [];
    for (const planId of this.ordered(keys[1])) {
      if (needed <= 0) break;
      const available = Number(this.hash(keys[2]).get(planId) ?? 0);
      if (available <= 0) continue;
      if (allocations.length >= Number(argv[16])) return [-4];
      const amount = Math.min(available, needed);
      allocations.push({ planId, amount });
      needed -= amount;
    }
    if (needed > 0) return [-1];
    wallet -= Number(argv[0]);
    this.strings.set(keys[0], wallet);
    for (const allocation of allocations) {
      const after = Number(this.hash(keys[2]).get(allocation.planId)) - allocation.amount;
      allocation.planBalanceAfter = after;
      this.hash(keys[2]).set(allocation.planId, String(after));
      if (after === 0) {
        this.hash(keys[4]).set(allocation.planId, CreditPlanStatus.DEPLETED);
        this.zset(keys[1]).delete(allocation.planId);
        const member = this.hash(keys[6]).get(allocation.planId);
        if (member) this.zset(keys[10]).delete(member);
      }
    }
    const expiresAt = Number(argv[8]) + Number(argv[9]);
    const json = JSON.stringify(allocations);
    const values: Record<string, string> = {
      reservationId: argv[1], scopeId: argv[2], appId: argv[3], tenantId: argv[4],
      appType: argv[5], creditType: argv[6], requestId: argv[7], amount: argv[0],
      remainingBalance: String(wallet),
      status: CreditReservationStatus.RESERVED,
      leaseToken: argv[10],
      createdAt: argv[8], expiresAt: String(expiresAt), version: '1',
      settlementMode: argv[12], operation: argv[13], autoRecover: argv[14],
      environment: argv[18], allocations: json,
    };
    this.hashes.set(keys[7], new Map(Object.entries(values)));
    this.hashes.set(keys[8], new Map(Object.entries(values)));
    if (argv[14] === '1') this.zset(keys[9]).set(argv[1], expiresAt);
    allocations.forEach((allocation, index) => this.events.push({
      type: CreditEventType.RESERVED,
      reservationId: argv[1], planId: allocation.planId,
      amount: allocation.amount, allocationIndex: index, allocationCount: allocations.length,
      environment: argv[18], billingMode: CreditBillingMode.ENFORCE,
    }));
    return [argv[1], wallet, expiresAt, 0, argv[10], argv[14], json];
  }

  private commit(keys: string[], argv: string[]) {
    const reservation = this.hashes.get(keys[0]);
    if (!reservation) return [-2];
    if (reservation.get('status') === CreditReservationStatus.COMMITTED) return [0];
    if (reservation.get('status') !== CreditReservationStatus.RESERVED) return [-1];
    reservation.set('status', CreditReservationStatus.COMMITTED);
    reservation.set('finalizedAt', argv[0]);
    this.zset(keys[1]).delete(argv[1]);
    const allocations = JSON.parse(reservation.get('allocations')!);
    allocations.forEach((allocation: any, index: number) => this.events.push({
      type: CreditEventType.COMMITTED,
      reservationId: argv[1], planId: allocation.planId,
      amount: allocation.amount, allocationIndex: index, allocationCount: allocations.length,
      environment: reservation.get('environment'),
      billingMode: CreditBillingMode.ENFORCE,
    }));
    allocations.forEach((allocation: any) => {
      const planBalanceAfter = Number(this.hash(keys[4]).get(allocation.planId) ?? 0);
      const threshold = Number(this.hash(keys[5]).get(allocation.planId) ?? 0);
      if (planBalanceAfter <= threshold) {
        this.events.push({
          type: CreditEventType.CRITICAL_BALANCE,
          planId: allocation.planId,
          planBalanceAfter, threshold, balanceAfter: this.strings.get(keys[6]) ?? 0,
        });
      }
    });
    return [1];
  }

  private refund(keys: string[], argv: string[], recovering: boolean) {
    const reservation = this.hashes.get(keys[0]);
    if (
      !reservation ||
      reservation.get('status') !== CreditReservationStatus.RESERVED
    ) {
      if (recovering) this.zset(keys[1]).delete(argv[3]);
      return [0];
    }
    if (recovering && (reservation.get('autoRecover') === '0' ||
        Number(reservation.get('expiresAt')) > Number(argv[1]))) return [0];
    let wallet = this.strings.get(keys[3]) ?? 0;
    const allocations = JSON.parse(reservation.get('allocations')!);
    const outcomes = allocations.map((allocation: any) => {
      const planId = allocation.planId;
      const current = Number(this.hash(keys[4]).get(planId) ?? 0);
      const planExpiresAt = Number(this.hash(keys[5]).get(planId) ?? 0);
      const status = this.hash(keys[6]).get(planId);
      if (
        planExpiresAt > Number(argv[1]) &&
        status !== CreditPlanStatus.EXPIRED &&
        status !== CreditPlanStatus.REVOKED
      ) {
        const after = current + Number(allocation.amount);
        this.hash(keys[4]).set(planId, String(after));
        this.hash(keys[6]).set(planId, CreditPlanStatus.ACTIVE);
        this.zset(keys[7]).set(planId, Number(this.hash(keys[8]).get(planId)));
        const member = this.hash(keys[10]).get(planId);
        if (member) this.zset(keys[9]).set(member, planExpiresAt);
        wallet += Number(allocation.amount);
        return { ...allocation, restoredAmount: allocation.amount, expiredAmount: 0,
          planBalanceAfter: after };
      }
      wallet -= current;
      this.hash(keys[4]).set(planId, '0');
      this.hash(keys[6]).set(planId, CreditPlanStatus.EXPIRED);
      this.zset(keys[7]).delete(planId);
      return { ...allocation, restoredAmount: 0, expiredAmount: allocation.amount,
        planBalanceAfter: 0 };
    });
    this.strings.set(keys[3], wallet);
    reservation.set('status', argv[0]);
    reservation.set('remainingBalance', String(wallet));
    this.zset(keys[1]).delete(argv[3]);
    outcomes.forEach((outcome: any) => this.events.push({
      type: argv[0], reservationId: argv[3], planId: outcome.planId,
      restoredAmount: outcome.restoredAmount, expiredAmount: outcome.expiredAmount,
      environment: reservation.get('environment'),
      billingMode: CreditBillingMode.ENFORCE,
    }));
    return [1, reservation.get('scopeId')!, reservation.get('appId')!,
      reservation.get('tenantId')!, reservation.get('appType')!,
      reservation.get('creditType')!, reservation.get('amount')!,
      reservation.get('operation')!, wallet, JSON.stringify(outcomes)];
  }

  private renew(keys: string[], argv: string[]) {
    const reservation = this.hashes.get(keys[0]);
    if (reservation?.get('status') !== CreditReservationStatus.RESERVED) return -1;
    if (reservation.get('leaseToken') !== argv[0]) return -2;
    const expiresAt = Number(argv[1]) + Number(argv[2]);
    reservation.set('expiresAt', String(expiresAt));
    reservation.set('version', String(Number(reservation.get('version')) + 1));
    if (reservation.get('autoRecover') !== '0') this.zset(keys[1]).set(argv[3], expiresAt);
    return expiresAt;
  }

  private expirePlan(keys: string[], argv: string[]) {
    const expiresAt = Number(this.hash(keys[3]).get(argv[1]) ?? 0);
    if (!expiresAt || expiresAt > Number(argv[0])) return [0];
    const status = this.hash(keys[4]).get(argv[1]);
    if (
      status === CreditPlanStatus.EXPIRED ||
      status === CreditPlanStatus.REVOKED
    ) {
      this.zset(keys[5]).delete(argv[2]); return [0];
    }
    const unused = Number(this.hash(keys[2]).get(argv[1]) ?? 0);
    const balance = (this.strings.get(keys[0]) ?? 0) - unused;
    this.strings.set(keys[0], balance);
    this.hash(keys[2]).set(argv[1], '0');
    this.hash(keys[4]).set(argv[1], CreditPlanStatus.EXPIRED);
    this.zset(keys[1]).delete(argv[1]);
    this.zset(keys[5]).delete(argv[2]);
    this.events.push({
      type: CreditEventType.PLAN_EXPIRED,
      planId: argv[1],
      expiredAmount: unused,
    });
    return [1, unused, balance];
  }
}

const subject: CreditSubject = {
  appId: 'app-1', tenantId: 'tenant-1', appType: 'KYC', creditType: 'API_CREDIT',
};

describe('CreditService FIFO recharge plans', () => {
  let clock = 1_800_000_000_000;
  let redis: PlanRedis;
  let service: CreditService;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    redis = new PlanRedis();
    service = new CreditService(redis, {
      ...DEFAULT_CREDIT_OPTIONS,
      catalog: { serviceType: 'kyc', version: '1', routes: [] },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const grant = (
    planId: string,
    amount: number,
    grantedAt: number,
    expiresAt: number,
    criticalBalance = 0,
  ) =>
    service.grant({
      subject, planId, amount, criticalBalance, grantedAt, expiresAt,
      referenceId: `reference-${planId}`,
    });

  it('starts uninitialized and the first grant creates a plan without a provider', async () => {
    expect(await service.getBalance(subject)).toBeNull();
    expect(await service.getPlans(subject)).toEqual([]);
    await expect(grant('plan-1', 100, clock - 100, clock + 10_000))
      .resolves.toMatchObject({ planId: 'plan-1', planBalance: 100, balance: 100 });
    expect(await service.getBalance(subject)).toBe(100);
  });

  it('records an idempotent dev observation without creating or changing a wallet', async () => {
    const input: ObserveCreditInput = {
      subject,
      requestId: 'dev-request:api',
      amount: 10,
      operation: 'POST /api/verify',
      environment: CreditEnvironment.DEV,
    };
    await expect(service.observe(input)).resolves.toMatchObject({
      eventId: '1-0', existing: false, requestedAmount: 10,
      deductedAmount: 0,
      environment: CreditEnvironment.DEV,
      billingMode: CreditBillingMode.OBSERVE,
    });
    await expect(service.observe(input)).resolves.toMatchObject({
      eventId: '1-0', existing: true,
    });
    await expect(service.observe({ ...input, amount: 11 }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(await service.getBalance(subject)).toBeNull();
    expect(await service.getPlans(subject)).toEqual([]);
    expect(redis.events).toEqual([
      expect.objectContaining({
        type: CreditEventType.CREDIT_OBSERVED,
        requestedAmount: 10,
        deductedAmount: 0,
        environment: CreditEnvironment.DEV,
        billingMode: CreditBillingMode.OBSERVE,
      }),
    ]);
  });

  it('rejects using the observation API for production traffic', async () => {
    await expect(service.observe({
      subject, amount: 10, environment: CreditEnvironment.PROD as any,
    })).rejects.toThrow('observe() supports only the dev environment');
  });

  it('deduplicates an exact plan retry and rejects changed semantics', async () => {
    const input = {
      subject, planId: 'plan-1', amount: 100, grantedAt: clock - 100,
      expiresAt: clock + 10_000, referenceId: 'reference-plan-1', criticalBalance: 20,
    };
    expect((await service.grant(input)).existing).toBe(false);
    expect((await service.grant(input)).existing).toBe(true);
    await expect(service.grant({ ...input, amount: 101 }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.grant({ ...input, criticalBalance: 21 }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(await service.getBalance(subject)).toBe(100);
  });

  it('rejects plan IDs and payment references reused by another wallet or plan', async () => {
    await grant('plan-1', 100, clock - 100, clock + 10_000);
    await expect(service.grant({
      subject: { ...subject, appId: 'app-2' }, planId: 'plan-1', amount: 100,
      grantedAt: clock - 100, expiresAt: clock + 10_000,
      referenceId: 'another-reference', criticalBalance: 20,
    })).rejects.toThrow('planId is already owned by another wallet');
    await expect(service.grant({
      subject, planId: 'plan-2', amount: 100, grantedAt: clock - 100,
      expiresAt: clock + 10_000, referenceId: 'reference-plan-1', criticalBalance: 20,
    })).rejects.toThrow('referenceId is already assigned to another plan');
  });

  it('allocates FIFO across plans and emits a separate commit event per plan', async () => {
    await grant('old-plan', 10, clock - 200, clock + 10_000);
    await grant('new-plan', 50, clock - 100, clock + 20_000);
    const reservation = await service.reserve({ subject, amount: 25, requestId: 'request-1' });
    expect(reservation).toMatchObject({
      environment: CreditEnvironment.PROD,
      billingMode: CreditBillingMode.ENFORCE,
    });
    expect(reservation.allocations).toEqual([
      { planId: 'old-plan', amount: 10, planBalanceAfter: 0 },
      { planId: 'new-plan', amount: 15, planBalanceAfter: 35 },
    ]);
    expect(await service.commit(reservation.reservationId)).toBe(true);
    expect(redis.events.filter((event) => event.type === CreditEventType.RESERVED))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          environment: CreditEnvironment.PROD,
          billingMode: CreditBillingMode.ENFORCE,
        }),
      ]));
    expect(redis.events.filter((event) =>
      event.type === CreditEventType.COMMITTED)).toEqual([
      expect.objectContaining({
        planId: 'old-plan', amount: 10, allocationIndex: 0,
        environment: CreditEnvironment.PROD,
        billingMode: CreditBillingMode.ENFORCE,
      }),
      expect.objectContaining({
        planId: 'new-plan', amount: 15, allocationIndex: 1,
        environment: CreditEnvironment.PROD,
        billingMode: CreditBillingMode.ENFORCE,
      }),
    ]);
    expect(await service.getBalance(subject)).toBe(35);
  });

  it('stores immutable plan thresholds and emits critical balance only on commit', async () => {
    await grant('plan-1', 100, clock - 100, clock + 10_000, 25);
    expect(await service.getPlans(subject)).toEqual([
      expect.objectContaining({ planId: 'plan-1', criticalBalance: 25 }),
    ]);

    const reservation = await service.reserve({ subject, amount: 80 });
    expect(redis.events.filter((event) =>
      event.type === CreditEventType.CRITICAL_BALANCE)).toHaveLength(0);

    await service.commit(reservation.reservationId);
    const critical = redis.events.find((event) =>
      event.type === CreditEventType.CRITICAL_BALANCE);
    expect(critical).toEqual(expect.objectContaining({
      type: CreditEventType.CRITICAL_BALANCE,
      planId: 'plan-1', planBalanceAfter: 20,
      threshold: 25, balanceAfter: 20,
    }));
    expect(critical).not.toHaveProperty('balance');
  });

  it('does not partially deduct when combined plans are insufficient', async () => {
    await grant('plan-1', 10, clock - 200, clock + 10_000);
    await grant('plan-2', 5, clock - 100, clock + 10_000);
    await expect(service.reserve({ subject, amount: 16 }))
      .rejects.toBeInstanceOf(InsufficientCreditsException);
    expect(await service.getBalance(subject)).toBe(15);
    expect((await service.getPlans(subject)).map((plan) => plan.availableAmount)).toEqual([10, 5]);
  });

  it('restores every allocation to its original active plan on rollback', async () => {
    await grant('plan-1', 10, clock - 200, clock + 100_000);
    await grant('plan-2', 20, clock - 100, clock + 100_000);
    const reservation = await service.reserve({ subject, amount: 15 });
    expect(await service.rollback(reservation.reservationId, 'failed')).toBe(true);
    expect(await service.getBalance(subject)).toBe(30);
    expect((await service.getPlans(subject)).map((plan) => plan.availableAmount)).toEqual([10, 20]);
  });

  it('does not resurrect a plan that expires while its credits are reserved', async () => {
    await grant('short-plan', 20, clock - 100, clock + 100);
    const reservation = await service.reserve({ subject, amount: 10 });
    clock += 101;
    expect(await service.rollback(reservation.reservationId, 'failed')).toBe(true);
    expect(await service.getBalance(subject)).toBe(0);
    expect(redis.events).toContainEqual(expect.objectContaining({
      type: CreditEventType.ROLLED_BACK,
      planId: 'short-plan', restoredAmount: 0, expiredAmount: 10,
    }));
  });

  it('allows commit after the funding plan expires', async () => {
    await grant('short-plan', 20, clock - 100, clock + 100);
    const reservation = await service.reserve({ subject, amount: 10 });
    clock += 101;
    expect(await service.commit(reservation.reservationId)).toBe(true);
    expect(redis.events).toContainEqual(expect.objectContaining({
      type: CreditEventType.COMMITTED, planId: 'short-plan', amount: 10,
    }));
  });

  it('recovers an expired split reservation exactly once', async () => {
    await grant('plan-1', 10, clock - 200, clock + 100_000);
    await grant('plan-2', 20, clock - 100, clock + 100_000);
    const reservation = await service.reserve({ subject, amount: 15 });
    const recovered = await service.recoverExpired(reservation.expiresAt + 1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].allocations).toHaveLength(2);
    expect(await service.recoverExpired(reservation.expiresAt + 1)).toHaveLength(0);
    expect(await service.getBalance(subject)).toBe(30);
  });

  it('expires unused plan credit through the stateless recovery pass', async () => {
    await grant('short-plan', 20, clock - 100, clock + 100);
    const expired = await service.recoverExpiredPlans(clock + 101);
    expect(expired).toEqual([expect.objectContaining({
      planId: 'short-plan', expiredAmount: 20, balanceAfter: 0,
    })]);
    expect(await service.recoverExpiredPlans(clock + 101)).toHaveLength(0);
  });

  it('expires stale availability before a later grant calculates balanceAfter', async () => {
    await grant('expired-plan', 20, clock - 200, clock + 100);
    clock += 101;
    const result = await grant('new-plan', 50, clock - 1, clock + 10_000);
    expect(result.balance).toBe(50);
    expect(await service.getBalance(subject)).toBe(50);
    expect(redis.events).toContainEqual(expect.objectContaining({
      type: CreditEventType.PLAN_EXPIRED,
      planId: 'expired-plan', expiredAmount: 20,
    }));
  });
});
