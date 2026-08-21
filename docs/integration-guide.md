# Integration guide

This guide takes a NestJS developer from installation to one verified credit
grant and one charged API request. You do not need to understand Lua, Redis
Streams, or BullMQ internals before following it.

> SDK version: `5.0.0`  
> Service type: `CreditServiceType.CAVACH_API` (`CAVACH_API` on the wire)  
> Credit type: `CreditType.API_CREDIT` (`API_CREDIT` on the wire)

`CreditServiceType.CAVACH_API` identifies the catalog and message transport.
`CreditAppType.CAVACH_API` identifies the `subject.appType` wallet dimension.
They currently serialize to the same text, but they are used in different
fields and are not interchangeable.

The SDK exports enums for every closed domain value. Use enum members in
TypeScript instead of typing strings yourself:

| Meaning | TypeScript | Stored or transmitted value |
| --- | --- | --- |
| Production request | `CreditEnvironment.PROD` | `prod` |
| Development request | `CreditEnvironment.DEV` | `dev` |
| Deduct credit | `CreditBillingMode.ENFORCE` | `ENFORCE` |
| Observe without deduction | `CreditBillingMode.OBSERVE` | `OBSERVE` |
| Immediate settlement | `CreditSettlementMode.IMMEDIATE` | `IMMEDIATE` |
| Deferred settlement | `CreditSettlementMode.DEFERRED` | `DEFERRED` |

Environment matching is strict. Uppercase `PROD` and `DEV` are invalid input;
authentication must supply lowercase `prod` or `dev`.

## First understand the two applications

The integration has two separate applications:

```text
trusted billing/event service                  real CAVACH API

creates a plan                                 receives an API request
        |                                              |
        +---- credit.commands.CAVACH_API -----> SDK grants the plan
                                                       |
                                                SDK deducts credit
                                                       |
        <---------- credit.lifecycle -------- lifecycle events

                    both use the same Redis
```

- The **real CAVACH API** installs `CreditModule`. The SDK automatically charges
  routes from its bundled catalog.
- The **trusted billing/event service** grants plans after payment or onboarding
  and stores lifecycle events. The repository's `example/event-server` shows
  this role.
- Redis is shared infrastructure. The two applications may run on different
  servers, but their Redis and BullMQ settings must match.

Do not add the example event server to the public API. It is trusted backend
infrastructure, and its grant endpoint is only a local integration example.

## Before you start

You need:

- Node.js 18 or newer;
- a NestJS 9–11 CAVACH API;
- Redis 6.2 or newer;
- authentication that can identify the application, tenant, and whether each
  request is `prod` or `dev`; and
- controllers that match the SDK's bundled CAVACH route catalog.

The last requirement is important. At startup the SDK compares the entire
NestJS route table with its bundled catalog. A small fake API with only one or
two test routes will fail intentionally.

## Step 1: install the API-host dependencies

Run this in the real CAVACH API:

```sh
npm install @hypersign-protocol/credit-middleware ioredis @nestjs/schedule
```

BullMQ is already included by the SDK. Do not pass a BullMQ provider or Redis
Stream client into `CreditModule`.

## Step 2: add the Redis connection

Add this environment variable to the real API:

```dotenv
REDIS_URL=redis://username:password@redis-host:6379/0
```

For local Redis, use:

```dotenv
REDIS_URL=redis://localhost:6379/0
```

Create `src/credit/credit-infrastructure.module.ts`:

```ts
import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { CREDIT_REDIS_CLIENT } from '@hypersign-protocol/credit-middleware';

@Injectable()
class CreditRedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(CREDIT_REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: CREDIT_REDIS_CLIENT,
      useFactory: async (): Promise<Redis> => {
        if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
        const redis = new Redis(process.env.REDIS_URL, {
          enableReadyCheck: true,
          maxRetriesPerRequest: 2,
        });
        await redis.ping();
        return redis;
      },
    },
    CreditRedisShutdown,
  ],
  exports: [CREDIT_REDIS_CLIENT],
})
export class CreditInfrastructureModule {}
```

Do not set ioredis's `keyPrefix`. The SDK manages its own Redis key namespace.

## Step 3: add five-minute recovery

Recovery finishes reservations left open when a request or process crashes and
expires unused plan credit. Create `src/credit/credit-recovery.scheduler.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CreditRecoveryService } from '@hypersign-protocol/credit-middleware';

@Injectable()
export class CreditRecoveryScheduler {
  constructor(private readonly recovery: CreditRecoveryService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'credit-recovery',
    waitForCompletion: true,
  })
  async run(): Promise<void> {
    await this.recovery.runOnce();
  }
}
```

`waitForCompletion` prevents overlapping runs inside one process. SDK Redis
operations also make multiple application instances safe.

## Step 4: register the SDK

Create `src/credit/credit-integration.module.ts`:

```ts
import { Global, Module, UnauthorizedException } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import {
  CreditAppType,
  CreditEnvironment,
  CreditModule,
  CreditType,
} from '@hypersign-protocol/credit-middleware';
import { CreditInfrastructureModule } from './credit-infrastructure.module';
import { CreditRecoveryScheduler } from './credit-recovery.scheduler';

interface TrustedServiceRequest {
  service?: {
    appId?: string;
    subdomain?: string;
    env?: string;
  };
  requestId?: string;
}

@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    CreditInfrastructureModule,
    CreditModule.forRootAsync({
      imports: [CreditInfrastructureModule],
      useFactory: () => ({
        requestContextResolver: (unknownRequest: unknown) => {
          const request = unknownRequest as TrustedServiceRequest;
          const environment = request.service?.env?.trim();
          if (
            environment !== CreditEnvironment.PROD &&
            environment !== CreditEnvironment.DEV
          ) {
            throw new UnauthorizedException(
              'Trusted service environment must be prod or dev',
            );
          }

          return {
            subject: {
              tenantId: request.service?.subdomain,
              appId: request.service?.appId ?? '',
              appType: CreditAppType.CAVACH_API,
              creditType: CreditType.API_CREDIT,
            },
            requestId: request.requestId,
            environment,
          };
        },
      }),
    }),
  ],
  providers: [CreditRecoveryScheduler],
  exports: [CreditModule],
})
export class CreditIntegrationModule {}
```

Import `CreditIntegrationModule` once in the root `AppModule`:

```ts
import { Module } from '@nestjs/common';
import { CreditIntegrationModule } from './credit/credit-integration.module';

@Module({
  imports: [
    CreditIntegrationModule,
    // Keep the application's existing modules here.
  ],
})
export class AppModule {}
```

If the application already calls `ScheduleModule.forRoot()`, do not call it a
second time. Keep the existing call and import scheduling only once.

The SDK supplies safe defaults for `leaseMs`, `retentionMs`, queue names,
Stream settings, and recovery batch size. Do not set them just to complete the
basic integration.

## Step 5: provide trusted identity for every request

Before the credit interceptor runs, authentication must set the service values.
A stable request ID is recommended when your gateway already creates one:

```ts
request.service = {
  appId: verifiedApplication.appId,
  subdomain: verifiedApplication.subdomain,
  env: verifiedApiCall.environment, // exactly prod or dev
};
request.requestId = trustedRequestId; // optional; the SDK generates one if absent
```

Use values obtained from a verified API key, access token, or database record.
Never copy billing identity or environment directly from an unauthenticated
request body, query parameter, or header.

The environment belongs to the individual API call:

| Environment | Result |
| --- | --- |
| `prod` (`CreditEnvironment.PROD`) | The SDK reserves and deducts the catalog price. |
| `dev` (`CreditEnvironment.DEV`) | The SDK emits `CREDIT_OBSERVED` with zero deduction. |
| Missing or another value | The SDK rejects the request before the controller runs. |

The resolved wallet has four exact fields:

```ts
{
  tenantId: request.service.subdomain,
  appId: request.service.appId,
  appType: CreditAppType.CAVACH_API,
  creditType: CreditType.API_CREDIT
}
```

The plan grant must use exactly the same values, including letter case.

## Step 6: keep the expected NestJS routing setup

In `main.ts`, keep the global prefix and URI versioning expected by the bundled
catalog:

```ts
import { VersioningType } from '@nestjs/common';

app.setGlobalPrefix('api');
app.enableVersioning({
  type: VersioningType.URI,
  defaultVersion: '1',
});
app.enableShutdownHooks();
```

Start the API. A successful startup means the catalog auditor found the exact
expected controllers and routes. Do not disable the audit to hide a mismatch.

## Step 7: grant the first plan

In the SDK source repository, start the trusted example event server:

```sh
export REDIS_URL=redis://localhost:6379/0
npm run start:example:events
```

This example is repository-only; it is not included in or importable from the
public npm package.

In another terminal, create timestamps and send a grant:

```sh
GRANTED_AT=$(node -p 'Date.now()')
EXPIRES_AT=$(node -p 'Date.now() + 30 * 24 * 60 * 60 * 1000')

curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d "{
    \"tenantId\": \"tenant/acme\",
    \"appId\": \"app:123\",
    \"planId\": \"api-plan-001\",
    \"amount\": 1000,
    \"grantedAt\": ${GRANTED_AT},
    \"expiresAt\": ${EXPIRES_AT}
  }"
```

Change `tenantId` and `appId` to the exact values resolved by the real API.
The endpoint intentionally does not accept `serviceType`, `appType`,
`creditType`, `referenceId`, or `criticalBalance`. The trusted server sets the
fixed types, generates internal IDs, and calculates the critical threshold as
40% of the granted amount.

A successful response contains `"queued": true`. Shortly afterward this
command should produce a `credit.granted` lifecycle job.

## Step 8: make the first prod and dev calls

Call one real catalog-priced CAVACH route using a verified `prod` credential.
The result should be:

1. the controller runs;
2. the wallet balance decreases by the route's catalog price; and
3. `credit.reserved` and `credit.committed` lifecycle jobs appear.

Call the same route using a verified `dev` credential. The controller still
runs, but the wallet balance does not change and `credit.observed` appears.

Inspect events received by the example process:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

## Final acceptance checklist

- [ ] The real API starts without a catalog-audit error.
- [ ] The grant response contains `queued: true`.
- [ ] A `credit.granted` event appears.
- [ ] A `prod` request reduces the correct wallet balance.
- [ ] A `dev` request emits an observation and deducts zero.
- [ ] A second plan can be granted before the first is exhausted.
- [ ] Consumption continues from plan 1 into plan 2 using FIFO.
- [ ] Recovery runs every five minutes.
- [ ] Application shutdown closes Redis cleanly.

## Common integration problems

| Symptom | Meaning and first check |
| --- | --- |
| API fails during startup | The real controllers, global prefix, or URI versions do not match the bundled catalog. |
| HTTP 401 before the controller | Authentication did not attach trusted `appId`, tenant, or a valid lowercase `prod`/`dev` environment. |
| Grant is queued but balance stays zero | The grant wallet does not exactly match the request wallet, or both applications use different Redis servers. |
| HTTP 402 with another plan available externally | The plan exists in a database but was not successfully granted into SDK Redis. Look for `credit.granted` or `credit.command-rejected`. |
| `dev` request deducts credit | The trusted authentication result incorrectly classified the call as `prod`. |
| Duplicate event handling | Persist lifecycle events with a unique database constraint on envelope `eventId`. |

After the first integration works, use the
[complete developer guide](developer-guide.md) for configuration, event
schemas, Redis keys, production operations, and troubleshooting details.
