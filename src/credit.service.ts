import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ACQUIRE_LOCK_SCRIPT,
  COMMIT_SCRIPT,
  FIND_EXPIRED_SCRIPT,
  GET_BALANCE_SCRIPT,
  GET_RESERVATION_SCRIPT,
  GRANT_SCRIPT,
  INITIALIZE_BALANCE_SCRIPT,
  RECOVER_SCRIPT,
  RELEASE_LOCK_SCRIPT,
  REMOVE_EXPIRATION_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  ROLLBACK_SCRIPT,
} from './credit.scripts';
import { CreditKeyspace } from './credit-keyspace';
import {
  CREDIT_OPTIONS,
  CREDIT_REDIS_CLIENT,
  CreditRedisClient,
  CreditReservation,
  CreditReservationStatus,
  CreditSubject,
  GrantCreditsInput,
  GrantCreditsResult,
  ReserveCreditInput,
  ReserveCreditResult,
  ResolvedCreditOptions,
} from './credit.types';
import { CreditEventDispatcher } from './events/credit.event-dispatcher';

export class InsufficientCreditsException extends HttpException {
  constructor() { super('Insufficient credits', HttpStatus.PAYMENT_REQUIRED); }
}

export class CreditBalanceInitializationException extends HttpException {
  constructor() {
    super('Credit balance initialization is already in progress', HttpStatus.SERVICE_UNAVAILABLE);
  }
}

export interface RecoveredReservation extends CreditSubject {
  subject: CreditSubject;
  scopeId: string;
  reservationId: string;
  amount: number;
  operation?: string;
  balanceAfter: number;
}

@Injectable()
export class CreditService {
  private readonly keys: CreditKeyspace;

  constructor(
    @Inject(CREDIT_REDIS_CLIENT) private readonly redis: CreditRedisClient,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
    private readonly dispatcher: CreditEventDispatcher,
  ) {
    this.keys = new CreditKeyspace(options);
  }

  async reserve(input: ReserveCreditInput): Promise<ReserveCreditResult> {
    const subject = this.keys.subject(input.subject);
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new TypeError('amount must be a positive safe integer');
    }
    const settlementMode = input.settlementMode ?? 'IMMEDIATE';
    if (input.autoRecover === false && settlementMode !== 'DEFERRED') {
      throw new TypeError('autoRecover can be disabled only for DEFERRED reservations');
    }
    // Resolve configuration before mutating Redis. A bad dynamic threshold
    // must not leave a reservation behind when reserve() throws.
    const threshold = this.resolveThreshold(subject);
    await this.initializeBalanceIfMissing(subject);

    const reservationId = randomUUID();
    const leaseToken = randomUUID();
    const requestId = input.requestId?.trim() || randomUUID();
    const scopeId = this.keys.scopeId(subject);
    const now = Date.now();
    const operation = input.operation ?? '';
    const autoRecover = input.autoRecover ?? true;
    const result = await this.redis.eval(
      RESERVE_SCRIPT,
      5,
      this.keys.balance(subject),
      this.keys.reservation(reservationId),
      this.keys.request(subject, requestId),
      this.keys.expirations(),
      this.keys.eventStream(),
      input.amount,
      reservationId,
      scopeId,
      subject.accountId,
      subject.tenantId ?? '',
      subject.accountType ?? '',
      subject.serviceId ?? '',
      subject.creditType ?? '',
      requestId,
      now,
      this.options.leaseMs,
      leaseToken,
      this.options.retentionMs,
      settlementMode,
      operation,
      autoRecover ? '1' : '0',
      this.options.eventStreamMaxLength,
    ) as Array<string | number>;

    if (!Array.isArray(result)) throw new Error(`Unexpected Redis reserve result: ${String(result)}`);
    if (Number(result[0]) === -1) throw new InsufficientCreditsException();
    if (Number(result[0]) === -2) {
      throw new BadRequestException('requestId was reused with different credit semantics');
    }
    if (Number(result[0]) === -3) {
      throw new Error('Scoped credit balance disappeared during reservation');
    }
    if (result.length !== 6) throw new Error(`Unexpected Redis reserve result: ${String(result)}`);

    const remainingBalance = Number(result[1]);
    const expiresAt = Number(result[2]);
    const existing = Number(result[3]) === 1;
    const storedAutoRecover = String(result[5]) !== '0';
    if (!existing) {
      this.dispatcher.dispatch({
        ...this.eventBase(subject, scopeId, now),
        type: 'RESERVED',
        reservationId: String(result[0]),
        requestId,
        amount: input.amount,
        balanceAfter: remainingBalance,
        expiresAt,
        settlementMode,
        operation: input.operation,
        autoRecover: storedAutoRecover,
      });
    }

    if (!existing && remainingBalance <= threshold) {
      this.dispatcher.dispatch({
        ...this.eventBase(subject, scopeId, now),
        type: 'CRITICAL_BALANCE',
        balance: remainingBalance,
        threshold,
      });
    }

    return {
      reservationId: String(result[0]),
      leaseToken: String(result[4]),
      scopeId,
      remainingBalance,
      expiresAt,
      autoRecover: storedAutoRecover,
      existing,
      settlementMode,
      subject,
    };
  }

  /** Atomically and idempotently tops up one scoped wallet. */
  async grant(input: GrantCreditsInput): Promise<GrantCreditsResult> {
    const subject = this.keys.subject(input.subject);
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new TypeError('grant amount must be a positive safe integer');
    }
    const referenceId = input.referenceId?.trim();
    if (!referenceId) throw new TypeError('referenceId is required');
    await this.initializeBalanceIfMissing(subject);
    const now = Date.now();
    const scopeId = this.keys.scopeId(subject);
    const result = await this.redis.eval(
      GRANT_SCRIPT,
      3,
      this.keys.balance(subject),
      this.keys.grant(subject, referenceId),
      this.keys.eventStream(),
      input.amount,
      now,
      scopeId,
      subject.accountId,
      subject.tenantId ?? '',
      subject.accountType ?? '',
      subject.serviceId ?? '',
      subject.creditType ?? '',
      referenceId,
      input.reason ?? '',
      this.options.retentionMs,
      this.options.eventStreamMaxLength,
    ) as Array<string | number>;
    if (Number(result[0]) === -1) {
      throw new BadRequestException('referenceId was reused with a different grant amount');
    }
    if (Number(result[0]) === -2) throw new Error('Scoped balance disappeared during grant');
    const balance = Number(result[0]);
    const existing = Number(result[1]) === 1;
    if (!existing) {
      this.dispatcher.dispatch({
        ...this.eventBase(subject, scopeId, now),
        type: 'CREDIT_GRANTED',
        referenceId,
        amount: input.amount,
        balanceAfter: balance,
        reason: input.reason,
      });
    }
    return { balance, existing, subject };
  }

  async commit(reservationId: string): Promise<boolean> {
    const reservation = await this.getReservation(reservationId);
    if (!reservation) return false;
    const now = Date.now();
    const result = await this.redis.eval(
      COMMIT_SCRIPT,
      4,
      this.keys.reservation(reservationId),
      this.keys.expirations(),
      this.keys.eventStream(),
      this.keys.request(reservation.subject, reservation.requestId!),
      now,
      reservationId,
      this.options.retentionMs,
      this.options.eventStreamMaxLength,
    ) as Array<string | number>;
    if (Number(result[0]) !== 1) return false;
    const parsed = this.parseFinalizationResult(result, true);
    this.dispatcher.dispatch({
      ...this.eventBase(parsed.subject, parsed.scopeId, now),
      type: 'COMMITTED',
      reservationId,
      amount: parsed.amount,
      balanceAfter: parsed.balanceAfter!,
      operation: parsed.operation,
    });
    return true;
  }

  async rollback(reservationId: string, reason = 'controller_failed'): Promise<boolean> {
    return this.refund(reservationId, 'ROLLED_BACK', reason, Date.now());
  }

  async renew(reservationId: string, leaseToken: string): Promise<number> {
    if (!leaseToken) throw new TypeError('leaseToken is required');
    const result = Number(await this.redis.eval(
      RENEW_SCRIPT,
      2,
      this.keys.reservation(reservationId),
      this.keys.expirations(),
      leaseToken,
      Date.now(),
      this.options.leaseMs,
      reservationId,
    ));
    if (result < 0) throw new Error(`Reservation ${reservationId} cannot be renewed`);
    return result;
  }

  async recoverExpired(now = Date.now()): Promise<RecoveredReservation[]> {
    const ids = await this.redis.eval(
      FIND_EXPIRED_SCRIPT,
      1,
      this.keys.expirations(),
      now,
      this.options.recoveryBatchSize,
    ) as string[];
    const recovered: RecoveredReservation[] = [];
    for (const reservationId of ids) {
      const reservation = await this.getReservation(reservationId);
      if (!reservation) {
        // A reservation hash may be absent after manual Redis maintenance,
        // eviction, or retention misconfiguration. Remove the dangling member
        // so it cannot permanently occupy every recovery batch.
        await this.redis.eval(
          REMOVE_EXPIRATION_SCRIPT,
          1,
          this.keys.expirations(),
          reservationId,
        );
        continue;
      }
      const result = await this.redis.eval(
        RECOVER_SCRIPT,
        5,
        this.keys.reservation(reservationId),
        this.keys.expirations(),
        this.keys.eventStream(),
        this.keys.balance(reservation.subject),
        this.keys.request(reservation.subject, reservation.requestId!),
        now,
        reservationId,
        this.options.retentionMs,
        this.options.eventStreamMaxLength,
      ) as Array<string | number>;
      if (Number(result[0]) !== 1) continue;
      const parsed = this.parseFinalizationResult(result, true);
      recovered.push({
        ...parsed.subject,
        subject: parsed.subject,
        scopeId: parsed.scopeId,
        reservationId,
        amount: parsed.amount,
        operation: parsed.operation,
        balanceAfter: parsed.balanceAfter!,
      });
    }
    return recovered;
  }

  async getReservation(reservationId: string): Promise<CreditReservation | null> {
    const result = await this.redis.eval(
      GET_RESERVATION_SCRIPT,
      1,
      this.keys.reservation(reservationId),
    ) as string[];
    if (!result.length) return null;
    const data: Record<string, string> = {};
    for (let index = 0; index < result.length; index += 2) {
      data[result[index]] = result[index + 1];
    }
    const subject = this.keys.subject({
      accountId: data.accountId,
      tenantId: data.tenantId || undefined,
      accountType: data.accountType || undefined,
      serviceId: data.serviceId || undefined,
      creditType: data.creditType || undefined,
    });
    const expectedScopeId = this.keys.scopeId(subject);
    if (data.scopeId !== expectedScopeId) {
      throw new Error(
        `Redis reservation scope mismatch: expected ${expectedScopeId}, received ${data.scopeId}`,
      );
    }
    return {
      ...subject,
      subject,
      reservationId: data.reservationId,
      scopeId: data.scopeId,
      requestId: data.requestId || undefined,
      amount: Number(data.amount),
      remainingBalance: Number(data.remainingBalance),
      status: data.status as CreditReservationStatus,
      createdAt: Number(data.createdAt),
      expiresAt: Number(data.expiresAt),
      autoRecover: data.autoRecover !== '0',
      finalizedAt: data.finalizedAt ? Number(data.finalizedAt) : undefined,
      finalizationReason: data.finalizationReason,
      settlementMode: data.settlementMode as CreditReservation['settlementMode'],
      operation: data.operation || undefined,
      version: Number(data.version),
    };
  }

  /** Returns null when this scoped wallet has never been initialized. */
  async getBalance(subjectInput: CreditSubject): Promise<number | null> {
    const subject = this.keys.subject(subjectInput);
    const raw = await this.redis.eval(GET_BALANCE_SCRIPT, 1, this.keys.balance(subject));
    return raw === null || raw === false ? null : Number(raw);
  }

  private async refund(
    reservationId: string,
    status: 'ROLLED_BACK' | 'EXPIRED',
    reason: string,
    now: number,
  ): Promise<boolean> {
    const reservation = await this.getReservation(reservationId);
    if (!reservation) return false;
    const result = await this.redis.eval(
      ROLLBACK_SCRIPT,
      5,
      this.keys.reservation(reservationId),
      this.keys.expirations(),
      this.keys.eventStream(),
      this.keys.balance(reservation.subject),
      this.keys.request(reservation.subject, reservation.requestId!),
      status,
      now,
      reason,
      reservationId,
      this.options.retentionMs,
      this.options.eventStreamMaxLength,
    ) as Array<string | number>;
    if (Number(result[0]) !== 1) return false;
    const parsed = this.parseFinalizationResult(result, true);
    this.dispatcher.dispatch({
      ...this.eventBase(parsed.subject, parsed.scopeId, now),
      type: 'ROLLED_BACK',
      reservationId,
      amount: parsed.amount,
      reason,
      operation: parsed.operation,
      balanceAfter: parsed.balanceAfter!,
    });
    return true;
  }

  private async initializeBalanceIfMissing(subject: CreditSubject): Promise<void> {
    if (await this.getBalance(subject) !== null) return;
    const provider = this.options.balanceProvider;
    if (!provider) {
      throw new Error(`Credit balance is not initialized for ${this.keys.scopeId(subject)}`);
    }
    const lockToken = randomUUID();
    const acquired = Number(await this.redis.eval(
      ACQUIRE_LOCK_SCRIPT,
      1,
      this.keys.initializationLock(subject),
      lockToken,
      this.options.initializationLockMs,
    )) === 1;
    if (!acquired) throw new CreditBalanceInitializationException();

    try {
      if (await this.getBalance(subject) !== null) return;
      const snapshot = await provider.getBalance(subject);
      if (!Number.isSafeInteger(snapshot.balance) || snapshot.balance < 0) {
        throw new Error('Credit balance provider returned an invalid balance');
      }
      const initialized = Number(await this.redis.eval(
        INITIALIZE_BALANCE_SCRIPT,
        1,
        this.keys.balance(subject),
        snapshot.balance,
      )) === 1;
      if (initialized) {
        const now = Date.now();
        this.dispatcher.dispatch({
          ...this.eventBase(subject, this.keys.scopeId(subject), now),
          type: 'BALANCE_INITIALIZED',
          balance: snapshot.balance,
          source: snapshot.source,
          revision: snapshot.revision,
        });
      }
    } finally {
      await this.redis.eval(
        RELEASE_LOCK_SCRIPT,
        1,
        this.keys.initializationLock(subject),
        lockToken,
      );
    }
  }

  private resolveThreshold(subject: CreditSubject): number {
    const configured = this.options.criticalBalance;
    const threshold = typeof configured === 'function' ? configured(subject) : configured;
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      throw new TypeError('criticalBalance must resolve to a non-negative safe integer');
    }
    return threshold;
  }

  private eventBase(subject: CreditSubject, scopeId: string, timestamp: number) {
    return {
      timestamp,
      subject,
      scopeId,
      accountId: subject.accountId,
      tenantId: subject.tenantId,
      accountType: subject.accountType,
      serviceId: subject.serviceId,
      creditType: subject.creditType,
    };
  }

  private parseFinalizationResult(
    result: Array<string | number>,
    includesBalanceAfter: boolean,
  ) {
    const expectedLength = includesBalanceAfter ? 10 : 9;
    if (result.length !== expectedLength) {
      throw new Error(
        `Unexpected Redis finalization result: expected ${expectedLength} fields, ` +
        `received ${result.length}`,
      );
    }
    const subject = this.keys.subject({
      accountId: String(result[2]),
      tenantId: result[3] ? String(result[3]) : undefined,
      accountType: result[4] ? String(result[4]) : undefined,
      serviceId: result[5] ? String(result[5]) : undefined,
      creditType: result[6] ? String(result[6]) : undefined,
    });
    const scopeId = String(result[1]);
    const expectedScopeId = this.keys.scopeId(subject);
    if (scopeId !== expectedScopeId) {
      throw new Error(
        `Redis finalization scope mismatch: expected ${expectedScopeId}, received ${scopeId}`,
      );
    }
    const amount = Number(result[7]);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`Redis finalization returned an invalid amount: ${String(result[7])}`);
    }
    const balanceAfter = includesBalanceAfter ? Number(result[9]) : undefined;
    if (includesBalanceAfter &&
        (!Number.isSafeInteger(balanceAfter) || balanceAfter! < 0)) {
      throw new Error(
        `Redis finalization returned an invalid balanceAfter: ${String(result[9])}`,
      );
    }
    return {
      scopeId,
      subject,
      amount,
      operation: result[8] ? String(result[8]) : undefined,
      balanceAfter,
    };
  }
}

export {
  ACQUIRE_LOCK_SCRIPT,
  COMMIT_SCRIPT,
  FIND_EXPIRED_SCRIPT,
  GRANT_SCRIPT,
  INITIALIZE_BALANCE_SCRIPT,
  RECOVER_SCRIPT,
  REMOVE_EXPIRATION_SCRIPT,
  RELEASE_LOCK_SCRIPT,
  RENEW_SCRIPT,
  RESERVE_SCRIPT,
  ROLLBACK_SCRIPT,
};
