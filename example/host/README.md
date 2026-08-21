# Use this example in a CAVACH NestJS service

This directory is a copy-ready integration example for the real NestJS API
whose controllers implement the SDK's bundled CAVACH catalog. It is not a
standalone application because a partial application would correctly fail the
catalog route audit.

For a walkthrough with every command and expected result, start with the
[integration guide](../../docs/integration-guide.md).
Use this page afterward as the copy-ready file reference.

## What each file does

| File | Copy into the host as | Purpose |
| --- | --- | --- |
| `credit-infrastructure.module.ts` | `src/credit/credit-infrastructure.module.ts` | Creates the one operation Redis client supplied to the SDK and closes it on shutdown. |
| `credit-integration.module.ts` | `src/credit/credit-integration.module.ts` | Registers `CreditModule`, maps authenticated requests to a wallet, and enables scheduling. |
| `credit-recovery.scheduler.ts` | `src/credit/credit-recovery.scheduler.ts` | Calls `CreditRecoveryService.runOnce()` every five minutes. |

## Step 1: install dependencies

```sh
npm install @hypersign-protocol/credit-middleware ioredis @nestjs/schedule
```

The SDK already contains BullMQ and creates its own command worker and Stream
relay. Do not create or inject a BullMQ provider for the SDK host.

## Step 2: configure Redis

```dotenv
REDIS_URL=redis://username:password@redis-host:6379/0
```

Use the same Redis deployment and BullMQ prefix in the trusted grant/lifecycle
service. Do not configure ioredis's `keyPrefix`; SDK financial keys and BullMQ
keys have separate configuration.

## Step 3: copy and import the modules

Copy the three files using the paths in the table, update their relative import
paths, replace the repository-only `../../src` SDK imports with
`@hypersign-protocol/credit-middleware`, and import the integration module once:

```ts
import { Module } from '@nestjs/common';
import { CreditIntegrationModule } from './credit/credit-integration.module';

@Module({
  imports: [
    CreditIntegrationModule,
    // Existing CAVACH application modules and controllers...
  ],
})
export class AppModule {}
```

`CreditIntegrationModule` currently calls `ScheduleModule.forRoot()`. If the
host already calls it elsewhere, keep only one `forRoot()` call and import the
existing scheduling module instead.

The host must retain the catalog-compatible Nest routing setup:

```ts
app.setGlobalPrefix('api');
app.enableVersioning({
  type: VersioningType.URI,
  defaultVersion: '1',
});
app.enableShutdownHooks();
```

Do not weaken or disable the startup audit. A mismatch means the application
controllers and the released price catalog are not compatible.

## Step 4: attach trusted request identity

Before the global credit interceptor runs, authentication must populate:

```ts
request.service = {
  appId: verifiedApplication.appId,
  subdomain: verifiedApplication.subdomain,
  env: verifiedApiCall.environment, // exactly lowercase prod or dev
};
request.requestId = trustedRequestId;
```

This is illustrative assignment code, not authorization logic. Derive every
value from an already verified API key, token, or service record. Do not trust
an `appId`, tenant, or environment copied directly from the request body,
query, or an unauthenticated header.

One server may process both environments:

- `prod` (`CreditEnvironment.PROD`) reserves and deducts catalog credit;
- `dev` (`CreditEnvironment.DEV`) emits `CREDIT_OBSERVED` with zero deduction;
  and
- missing or unknown values are rejected before the controller executes.

The example resolves this wallet:

```ts
{
  tenantId: request.service.subdomain,
  appId: request.service.appId,
  appType: CreditAppType.CAVACH_API,
  creditType: CreditType.API_CREDIT
}
```

Every grant must use exactly the same four values. Case changes or an omitted
dimension create a different wallet.

## Step 5: start the external grant/lifecycle service

From the SDK repository:

```sh
npm run start:example:events
```

Then follow [the grant walkthrough](../event-server/README.md). The HTTP example
accepts only plan/business values. It fixes `CAVACH_API` and `API_CREDIT`,
generates the internal reference, and calculates the 40% critical threshold.

In production, replace this HTTP demonstration with a trusted payment or
onboarding workflow that publishes the same schema-v3 command. Never expose the
raw credit command queue to untrusted clients.

## Step 6: verify the complete flow

Run these checks before enabling paid traffic:

1. Start the real API host and confirm `CreditCatalogAuditor` validates every
   route without missing or duplicate routes.
2. Grant `api-plan-001` and confirm the command job completes on
   `credit.commands.CAVACH_API`.
3. Confirm `credit.granted` arrives on `credit.lifecycle`.
4. Inject `CreditService` in a temporary authenticated diagnostic endpoint or
   test and confirm `getBalance()` returns the granted amount for the exact
   resolved subject. Do not keep an unauthenticated balance endpoint.
5. Call one priced route as `prod` and confirm `credit.reserved` followed by
   `credit.committed`.
6. Call the same route as `dev` and confirm `credit.observed` with
   `deductedAmount: 0` and no wallet balance change.
7. Grant a second plan before plan 1 runs out. Confirm FIFO consumes plan 1 and
   then plan 2 without HTTP 402.
8. Confirm the recovery cron runs every five minutes and shutdown closes Redis
   cleanly.

Inspect lifecycle events in the demonstration process:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

## Step 7: replace demonstration storage

The event server intentionally stores only a bounded in-memory list. A real
lifecycle consumer must:

1. validate schema version, service type, job name, and event type;
2. enforce a durable unique constraint on envelope `eventId`;
3. write the event receipt and financial side effect in one database
   transaction; and
4. throw before acknowledging when persistence fails so BullMQ retries.

Workers on one BullMQ queue compete. Configure separate lifecycle queue names
when multiple systems must each receive every event.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Startup route-audit failure | The host must implement exactly the bundled catalog routes with prefix `api` and URI versions. |
| HTTP 401 before controller | Auth did not provide a valid lowercase per-request `prod` or `dev` environment. |
| HTTP 402 despite plan 2 in the database | Confirm plan 2 produced `CREDIT_GRANTED` and exists in the SDK Redis FIFO wallet. |
| Grant command rejected | Inspect `credit.command-rejected` for subject, timestamp, identifier, or amount validation errors. |
| Duplicate lifecycle processing | Add a durable unique index on envelope `eventId`; BullMQ delivery is at least once. |

For exact Redis patterns and safe inspection commands, see the
[Redis keyspace reference](../../docs/redis-keyspace.md). For every SDK option
and event schema, see the [developer guide](../../docs/developer-guide.md).
