import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EMPTY, lastValueFrom, of, throwError, toArray } from 'rxjs';
import { CreditCost } from '../src/credit.decorator';
import { CreditInterceptor } from '../src/credit.interceptor';
import { CreditService, InsufficientCreditsException } from '../src/credit.service';
import { CREDIT_BOUNDARY_STATE } from '../src/credit-boundary.middleware';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';

class TestController {
  @CreditCost(20)
  endpoint() {}
}

class DeferredController {
  @CreditCost({ amount: 20, settlementMode: 'DEFERRED', operation: 'ASYNC_JOB' })
  endpoint() {}
}

const context = {
  getHandler: () => TestController.prototype.endpoint,
  getClass: () => TestController,
  switchToHttp: () => ({
    getRequest: () => ({ user: { id: 'user_123' }, requestId: 'req_123' }),
  }),
} as unknown as ExecutionContext;
const subject = { accountId: 'user_123' };
const scopeId =
  'tenant=0|accountType=0|account=1:user_123|service=0|creditType=0';
const reserveResult = (settlementMode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE') => ({
  reservationId: 'res_1', scopeId, subject, remainingBalance: 80,
  leaseToken: 'lease_1',
  expiresAt: Date.now() + 60_000, autoRecover: true,
  existing: false, settlementMode,
});

describe('CreditInterceptor', () => {
  const service = {
    reserve: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    getReservation: jest.fn(),
  } as unknown as jest.Mocked<CreditService>;
  const interceptor = new CreditInterceptor(
    new Reflector(),
    service,
    DEFAULT_CREDIT_OPTIONS,
  );

  beforeEach(() => jest.clearAllMocks());

  it('commits after a successful controller response', async () => {
    service.reserve.mockResolvedValue(reserveResult());
    service.commit.mockResolvedValue(true);
    const next = { handle: jest.fn(() => of({ success: true })) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next)))
      .resolves.toEqual({ success: true });
    expect(service.reserve).toHaveBeenCalledWith({
      subject, requestId: 'req_123', amount: 20,
      settlementMode: 'IMMEDIATE', operation: 'endpoint',
    });
    expect(service.commit).toHaveBeenCalledWith('res_1');
    expect(service.rollback).not.toHaveBeenCalled();
  });

  it('commits once after a successful empty controller Observable', async () => {
    service.reserve.mockResolvedValue(reserveResult());
    service.commit.mockResolvedValue(true);

    await new Promise<void>((resolve, reject) => {
      interceptor.intercept(
        context,
        { handle: () => EMPTY } as CallHandler,
      ).subscribe({ complete: resolve, error: reject });
    });

    expect(service.commit).toHaveBeenCalledTimes(1);
    expect(service.commit).toHaveBeenCalledWith('res_1');
  });

  it('commits once after all controller Observable values', async () => {
    service.reserve.mockResolvedValue(reserveResult());
    service.commit.mockResolvedValue(true);

    await expect(lastValueFrom(interceptor.intercept(
      context,
      { handle: () => of('first', 'second') } as CallHandler,
    ).pipe(toArray()))).resolves.toEqual(['first', 'second']);

    expect(service.commit).toHaveBeenCalledTimes(1);
  });

  it('fails the request when an immediate reservation cannot be committed', async () => {
    service.reserve.mockResolvedValue(reserveResult());
    service.commit.mockResolvedValue(false);
    service.rollback.mockResolvedValue(false);

    await expect(lastValueFrom(interceptor.intercept(
      context,
      { handle: () => of({ success: true }) } as CallHandler,
    ))).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(service.rollback).toHaveBeenCalledWith(
      'res_1',
      'Credit reservation res_1 could not be committed',
    );
  });

  it('rolls back and preserves the original controller error', async () => {
    const controllerError = new Error('Demo failure');
    service.reserve.mockResolvedValue(reserveResult());
    service.rollback.mockResolvedValue(true);
    const next = {
      handle: jest.fn(() => throwError(() => controllerError)),
    } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next)))
      .rejects.toBe(controllerError);
    expect(service.rollback).toHaveBeenCalledWith('res_1', 'Demo failure');
    expect(service.commit).not.toHaveBeenCalled();
  });

  it('rolls back when a downstream handler throws synchronously', async () => {
    const controllerError = new Error('Synchronous handler failure');
    service.reserve.mockResolvedValue(reserveResult());
    service.rollback.mockResolvedValue(true);
    const next = {
      handle: jest.fn(() => { throw controllerError; }),
    } as unknown as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next)))
      .rejects.toBe(controllerError);
    expect(service.rollback).toHaveBeenCalledWith(
      'res_1',
      'Synchronous handler failure',
    );
    expect(service.commit).not.toHaveBeenCalled();
  });

  it('does not execute the controller when reserve fails', async () => {
    service.reserve.mockRejectedValue(new InsufficientCreditsException());
    const next = { handle: jest.fn(() => of('never')) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next)))
      .rejects.toBeInstanceOf(InsufficientCreditsException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('does not execute the controller again for an existing request reservation', async () => {
    service.reserve.mockResolvedValue({ ...reserveResult(), existing: true });
    const next = { handle: jest.fn(() => of('duplicate')) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next)))
      .rejects.toBeInstanceOf(ConflictException);

    expect(next.handle).not.toHaveBeenCalled();
    expect(service.commit).not.toHaveBeenCalled();
    expect(service.rollback).not.toHaveBeenCalled();
  });

  it('uses the configured request context resolver', async () => {
    const serviceRequest = {
      service: { businessId: 'business_123' },
      correlationId: 'correlation_123',
    };
    const configuredInterceptor = new CreditInterceptor(
      new Reflector(),
      service,
      {
        ...DEFAULT_CREDIT_OPTIONS,
        requestContextResolver: (request: unknown) => {
          const value = request as typeof serviceRequest;
          return {
            subject: { accountId: value.service.businessId },
            requestId: value.correlationId,
          };
        },
      },
    );
    service.reserve.mockResolvedValue({
      ...reserveResult(), reservationId: 'res_service',
      subject: { accountId: 'business_123' },
    });
    service.commit.mockResolvedValue(true);
    const serviceContext = {
      ...context,
      switchToHttp: () => ({ getRequest: () => serviceRequest }),
    } as unknown as ExecutionContext;

    await lastValueFrom(configuredInterceptor.intercept(
      serviceContext,
      { handle: () => of('ok') } as CallHandler,
    ));

    expect(service.reserve).toHaveBeenCalledWith(expect.objectContaining({
      subject: { accountId: 'business_123' },
      requestId: 'correlation_123',
    }));
  });

  it('does not commit a successful deferred reservation', async () => {
    service.reserve.mockResolvedValue({
      ...reserveResult('DEFERRED'), reservationId: 'res_deferred',
    });
    const deferredContext = {
      ...context,
      getHandler: () => DeferredController.prototype.endpoint,
      getClass: () => DeferredController,
    } as unknown as ExecutionContext;

    await expect(lastValueFrom(interceptor.intercept(
      deferredContext,
      { handle: () => of({ accepted: true }) } as CallHandler,
    ))).resolves.toEqual({ accepted: true });
    expect(service.commit).not.toHaveBeenCalled();
    expect(service.rollback).not.toHaveBeenCalled();
  });

  it('claims an early reservation without reserving twice', async () => {
    const boundary = {
      reservationId: 'res_early', scopeId, requestId: 'req_123',
      policy: { method: 'POST', path: '/paid', amount: 20 },
      claimedByInterceptor: false, finalized: false,
    };
    const request = {
      user: { id: 'user_123' }, requestId: 'req_123',
      [CREDIT_BOUNDARY_STATE]: boundary,
    };
    service.getReservation.mockResolvedValue({
      reservationId: 'res_early', scopeId, subject, accountId: 'user_123',
      requestId: 'req_123', amount: 20, remainingBalance: 80,
      status: 'RESERVED', createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, autoRecover: true,
      settlementMode: 'IMMEDIATE',
      operation: 'endpoint', version: 1,
    });
    service.commit.mockResolvedValue(true);
    const earlyContext = {
      ...context,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await lastValueFrom(interceptor.intercept(
      earlyContext,
      { handle: () => of('ok') } as CallHandler,
    ));
    expect(service.reserve).not.toHaveBeenCalled();
    expect(service.commit).toHaveBeenCalledWith('res_early');
    expect(boundary.claimedByInterceptor).toBe(true);
    expect(boundary.finalized).toBe(true);
  });

  it('rejects an early reservation when another wallet dimension is resolved', async () => {
    const tenantSubject = { accountId: 'user_123', tenantId: 'tenant_a' };
    const tenantScope =
      'tenant=1:tenant_a|accountType=0|account=1:user_123|service=0|creditType=0';
    const boundary = {
      reservationId: 'res_early', scopeId: tenantScope, requestId: 'req_123',
      policy: { method: 'POST', path: '/paid', amount: 20 },
      claimedByInterceptor: false, finalized: false,
    };
    service.getReservation.mockResolvedValue({
      reservationId: 'res_early', scopeId: tenantScope,
      subject: tenantSubject, ...tenantSubject,
      requestId: 'req_123', amount: 20, remainingBalance: 80,
      status: 'RESERVED', createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, autoRecover: true,
      settlementMode: 'IMMEDIATE', operation: 'endpoint', version: 1,
    });
    const changedRequest = {
      user: { id: 'user_123' }, requestId: 'req_123',
      [CREDIT_BOUNDARY_STATE]: boundary,
    };
    const changedContext = {
      ...context,
      switchToHttp: () => ({ getRequest: () => changedRequest }),
    } as unknown as ExecutionContext;
    const changedInterceptor = new CreditInterceptor(
      new Reflector(),
      service,
      {
        ...DEFAULT_CREDIT_OPTIONS,
        requestContextResolver: () => ({
          subject: { accountId: 'user_123', tenantId: 'tenant_b' },
          requestId: 'req_123',
        }),
      },
    );

    await expect(lastValueFrom(changedInterceptor.intercept(
      changedContext,
      { handle: () => of('never') } as CallHandler,
    ))).rejects.toThrow('does not match');
    expect(service.commit).not.toHaveBeenCalled();
  });
});
