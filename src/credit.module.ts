import { DynamicModule, Module, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { DiscoveryModule } from "@nestjs/core";
import { CreditCatalogAuditor } from "./credit.catalog-auditor";
import { CreditCatalogService } from "./credit.catalog";
import { CreditPolicyExecutor } from "./credit-policy.executor";
import { CreditCommandWorker, CreditEventRelay } from "./credit.transport";
import { DEFAULT_CREDIT_OPTIONS } from "./credit.constants";
import { CreditRecoveryService } from "./credit-recovery.service";
import { CreditInterceptor } from "./credit.interceptor";
import { CreditService } from "./credit.service";
import { CreditBoundaryMiddleware } from "./credit-boundary.middleware";
import {
  CREDIT_OPTIONS,
  CreditModuleAsyncOptions,
  CreditCatalog,
  CreditOptions,
  ResolvedCreditOptions,
} from "./credit.types";

import catalogKycJson from "./catalogs/catalog.kyc.json";

const CATALOG_KYC = catalogKycJson as CreditCatalog;
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

export function resolveCreditOptions(
  options: CreditOptions,
): ResolvedCreditOptions {
  const catalogId = CATALOG_KYC.catalogId?.trim();
  const catalogVersion = CATALOG_KYC.version?.trim();
  if (!catalogId) throw new TypeError("catalog.catalogId is required");
  if (!catalogVersion) throw new TypeError("catalog.version is required");
  const catalog = {
    ...CATALOG_KYC,
    catalogId,
    version: catalogVersion,
  };
  const keyPrefix =
    options.keyPrefix?.trim() || DEFAULT_CREDIT_OPTIONS.keyPrefix;
  const redisHashTag =
    options.redisHashTag?.trim() || DEFAULT_CREDIT_OPTIONS.redisHashTag;
  if (keyPrefix.includes("{") || keyPrefix.includes("}")) {
    throw new TypeError("keyPrefix cannot contain Redis hash-tag braces");
  }
  if (redisHashTag.includes("{") || redisHashTag.includes("}")) {
    throw new TypeError("redisHashTag cannot contain braces");
  }
  const resolved: ResolvedCreditOptions = {
    ...DEFAULT_CREDIT_OPTIONS,
    ...options,
    catalog,
    keyPrefix,
    redisHashTag,
    maxActivePlans:
      options.maxActivePlans ?? DEFAULT_CREDIT_OPTIONS.maxActivePlans,
    maxPlanAllocationsPerReservation:
      options.maxPlanAllocationsPerReservation ??
      DEFAULT_CREDIT_OPTIONS.maxPlanAllocationsPerReservation,
    eventStreamKey: `${keyPrefix}:v2:{${redisHashTag}}:events`,
    bullMq: options.bullMq
      ? {
          ...options.bullMq,
          lifecycleQueueNames: options.bullMq.lifecycleQueueNames ?? [
            "credit.lifecycle",
          ],
          commandQueueName:
            options.bullMq.commandQueueName ?? `credit.commands.${catalogId}`,
          consumerGroup:
            options.bullMq.consumerGroup ?? `credit-bull-relay:${catalogId}`,
          batchSize: options.bullMq.batchSize ?? 100,
          blockMs: options.bullMq.blockMs ?? 5_000,
          pendingIdleMs: options.bullMq.pendingIdleMs ?? 30_000,
        }
      : undefined,
  };
  for (const [name, value] of [
    ["leaseMs", resolved.leaseMs],
    ["retentionMs", resolved.retentionMs],
    ["recoveryBatchSize", resolved.recoveryBatchSize],
    ["maxActivePlans", resolved.maxActivePlans],
    [
      "maxPlanAllocationsPerReservation",
      resolved.maxPlanAllocationsPerReservation,
    ],
    ["eventStreamMaxLength", resolved.eventStreamMaxLength],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (
    typeof resolved.criticalBalance === "number" &&
    (!Number.isSafeInteger(resolved.criticalBalance) ||
      resolved.criticalBalance < 0)
  ) {
    throw new TypeError("criticalBalance must be a non-negative safe integer");
  }
  if (resolved.bullMq) {
    for (const [name, value] of [
      ["bullMq.batchSize", resolved.bullMq.batchSize],
      ["bullMq.blockMs", resolved.bullMq.blockMs],
      ["bullMq.pendingIdleMs", resolved.bullMq.pendingIdleMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
    if (
      resolved.bullMq.lifecycleQueueNames.length === 0 ||
      resolved.bullMq.lifecycleQueueNames.some((name) => !name.trim())
    ) {
      throw new TypeError(
        "bullMq.lifecycleQueueNames must contain valid queue names",
      );
    }
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

  /** DI-friendly registration for configuration and host infrastructure providers. */
  static forRootAsync(options: CreditModuleAsyncOptions): DynamicModule {
    return this.createDynamicModule(
      {
        provide: CREDIT_OPTIONS,
        inject: options.inject ?? [],
        useFactory: async (...args: any[]) => {
          const opts = await options.useFactory(...args);
          return resolveCreditOptions(opts);
        },
      },
      options.imports,
    );
  }

  private static createDynamicModule(
    optionsProvider: Provider,
    imports: CreditModuleAsyncOptions["imports"] = [],
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
