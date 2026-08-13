import { DynamicModule, Module, Provider } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { DEFAULT_CREDIT_OPTIONS } from './credit.constants';
import { CreditRecoveryService } from './credit-recovery.service';
import { CreditInterceptor } from './credit.interceptor';
import { CreditService } from './credit.service';
import { CreditBoundaryMiddleware } from './credit-boundary.middleware';
import { CreditEventDispatcher } from './events/credit.event-dispatcher';
import {
  CREDIT_OPTIONS,
  CreditModuleAsyncOptions,
  CreditOptions,
  ResolvedCreditOptions,
} from './credit.types';

const runtimeProviders: Provider[] = [
  CreditEventDispatcher,
  CreditService,
  CreditBoundaryMiddleware,
  CreditRecoveryService,
  Reflector,
  { provide: APP_INTERCEPTOR, useClass: CreditInterceptor },
];

export function resolveCreditOptions(options: CreditOptions): ResolvedCreditOptions {
  const keyPrefix = options.keyPrefix?.trim() || DEFAULT_CREDIT_OPTIONS.keyPrefix;
  const redisHashTag = options.redisHashTag?.trim() || DEFAULT_CREDIT_OPTIONS.redisHashTag;
  if (keyPrefix.includes('{') || keyPrefix.includes('}')) {
    throw new TypeError('keyPrefix cannot contain Redis hash-tag braces');
  }
  if (redisHashTag.includes('{') || redisHashTag.includes('}')) {
    throw new TypeError('redisHashTag cannot contain braces');
  }
  const resolved: ResolvedCreditOptions = {
    ...DEFAULT_CREDIT_OPTIONS,
    ...options,
    keyPrefix,
    redisHashTag,
    initializationLockMs:
      options.initializationLockMs ?? DEFAULT_CREDIT_OPTIONS.initializationLockMs,
    eventStreamKey: `${keyPrefix}:{${redisHashTag}}:events`,
  };
  for (const [name, value] of [
    ['leaseMs', resolved.leaseMs],
    ['retentionMs', resolved.retentionMs],
    ['recoveryBatchSize', resolved.recoveryBatchSize],
    ['initializationLockMs', resolved.initializationLockMs],
    ['eventStreamMaxLength', resolved.eventStreamMaxLength],
    ['eventHandlerQueueSize', resolved.eventHandlerQueueSize],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (typeof resolved.criticalBalance === 'number' &&
      (!Number.isSafeInteger(resolved.criticalBalance) ||
        resolved.criticalBalance < 0)) {
    throw new TypeError('criticalBalance must be a non-negative safe integer');
  }
  return resolved;
}

@Module({})
export class CreditModule {
  static forRoot(options: CreditOptions): DynamicModule {
    return this.createDynamicModule({
      provide: CREDIT_OPTIONS,
      useValue: resolveCreditOptions(options),
    });
  }

  /** DI-friendly registration for ConfigService, providers, and event handlers. */
  static forRootAsync(options: CreditModuleAsyncOptions): DynamicModule {
    return this.createDynamicModule(
      {
        provide: CREDIT_OPTIONS,
        inject: options.inject ?? [],
        useFactory: async (...args: any[]) =>
          resolveCreditOptions(await options.useFactory(...args)),
      },
      options.imports,
    );
  }

  private static createDynamicModule(
    optionsProvider: Provider,
    imports: CreditModuleAsyncOptions['imports'] = [],
  ): DynamicModule {
    return {
      module: CreditModule,
      global: true,
      imports,
      providers: [optionsProvider, ...runtimeProviders],
      exports: [
        CREDIT_OPTIONS,
        CreditService,
        CreditRecoveryService,
        CreditBoundaryMiddleware,
      ],
    };
  }
}
