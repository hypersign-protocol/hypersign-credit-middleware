import { DynamicModule, Module, Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DiscoveryModule } from '@nestjs/core';
import { CreditCatalogAuditor } from './credit.catalog-auditor';
import { CreditCatalogService } from './credit.catalog';
import { CreditPolicyExecutor } from './credit-policy.executor';
import { CreditCommandWorker, CreditEventRelay } from './credit.transport';
import { DEFAULT_CREDIT_OPTIONS } from './credit.constants';
import { CreditRecoveryService } from './credit-recovery.service';
import { CreditInterceptor } from './credit.interceptor';
import { CreditService } from './credit.service';
import { CreditBoundaryMiddleware } from './credit-boundary.middleware';
import {
  CREDIT_OPTIONS,
  CreditCatalog,
  CreditModuleAsyncOptions,
  CreditOptions,
  ResolvedCreditOptions,
} from './credit.types';

import CatalogKYC from './catalogs/catalog.kyc.json';

const runtimeProviders: Provider[] = [
  CreditCatalogService,
  CreditCatalogAuditor,
  CreditPolicyExecutor,
  CreditEventRelay,
  CreditCommandWorker,
  CreditService,
  CreditBoundaryMiddleware,
  CreditRecoveryService,
  { provide: APP_INTERCEPTOR, useClass: CreditInterceptor },
];

export function resolveCreditOptions(options: CreditOptions): ResolvedCreditOptions {
  if (!options.catalog) throw new TypeError('catalog is required');
  const catalogServiceId = options.catalog.serviceId?.trim();
  const catalogVersion = options.catalog.version?.trim();
  if (!catalogServiceId) throw new TypeError('catalog.serviceId is required');
  if (!catalogVersion) throw new TypeError('catalog.version is required');
  const catalog = {
    ...options.catalog,
    serviceId: catalogServiceId,
    version: catalogVersion,
  };
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
    catalog,
    keyPrefix,
    redisHashTag,
    initializationLockMs:
      options.initializationLockMs ?? DEFAULT_CREDIT_OPTIONS.initializationLockMs,
    eventStreamKey: `${keyPrefix}:{${redisHashTag}}:events`,
    bullMq: options.bullMq ? {
      ...options.bullMq,
      lifecycleQueueNames: options.bullMq.lifecycleQueueNames ?? ['credit.lifecycle'],
      commandQueueName: options.bullMq.commandQueueName ??
        `credit.commands.${catalogServiceId}`,
      consumerGroup: options.bullMq.consumerGroup ??
        `credit-bull-relay:${catalogServiceId}`,
      batchSize: options.bullMq.batchSize ?? 100,
      blockMs: options.bullMq.blockMs ?? 5_000,
      pendingIdleMs: options.bullMq.pendingIdleMs ?? 30_000,
    } : undefined,
  };
  for (const [name, value] of [
    ['leaseMs', resolved.leaseMs],
    ['retentionMs', resolved.retentionMs],
    ['recoveryBatchSize', resolved.recoveryBatchSize],
    ['initializationLockMs', resolved.initializationLockMs],
    ['eventStreamMaxLength', resolved.eventStreamMaxLength],
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
  if (resolved.bullMq) {
    for (const [name, value] of [
      ['bullMq.batchSize', resolved.bullMq.batchSize],
      ['bullMq.blockMs', resolved.bullMq.blockMs],
      ['bullMq.pendingIdleMs', resolved.bullMq.pendingIdleMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
    if (resolved.bullMq.lifecycleQueueNames.length === 0 ||
        resolved.bullMq.lifecycleQueueNames.some((name) => !name.trim())) {
      throw new TypeError('bullMq.lifecycleQueueNames must contain valid queue names');
    }
  }
  return resolved;
}

@Module({})
export class CreditModule {
  static forRoot(options: CreditOptions): DynamicModule {
    options['catalog'] = options?.catalog ?? CatalogKYC as CreditCatalog;
    return this.createDynamicModule({
      provide: CREDIT_OPTIONS,
      useValue: resolveCreditOptions(options),
    });
  }

  /** DI-friendly registration for configuration and host infrastructure providers. */
  static forRootAsync(options: CreditModuleAsyncOptions): DynamicModule {

    return this.createDynamicModule(
      {
        provide: CREDIT_OPTIONS,
        inject: options.inject ?? [],
        useFactory: async (...args: any[]) => {
          const opts = await options.useFactory(...args);
          opts['catalog'] = opts?.catalog ?? (CatalogKYC as CreditCatalog);
          return resolveCreditOptions(opts);
        },
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
      imports: [DiscoveryModule, ...(imports ?? [])],
      providers: [optionsProvider, ...runtimeProviders],
      exports: [
        CREDIT_OPTIONS,
        CreditService,
        CreditRecoveryService,
        CreditBoundaryMiddleware,
        CreditCatalogService,
        CreditPolicyExecutor,
      ],
    };
  }
}
