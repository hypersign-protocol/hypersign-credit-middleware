# SDK integration examples

The example folder has two intentionally separate parts:

- `host/` contains compile-checked NestJS modules to copy into the real CAVACH
  API application that owns the complete bundled route catalog.
- `event-server/` is a runnable external billing process. It publishes trusted
  plan grants and consumes lifecycle events.

There is no standalone fake API server. `CreditModule` audits the complete
bundled CAVACH catalog at startup, so a small server with invented `/demo`
routes would correctly fail its route audit. Use the host snippets inside the
real API whose controllers match the catalog.

## Build the examples

```sh
npm run build:example
```

## Integrate the API host

1. Copy or adapt the three files in `host/`.
2. Ensure authenticated requests contain trusted `service.appId`,
   `service.subdomain`, `service.env`, and `requestId` values before the global
   credit interceptor executes.
3. Import `CreditIntegrationModule` once in the root application module.
4. Keep the application's global prefix and URI versioning aligned with the
   bundled catalog (`api`, URI `v`, default version `1`).
5. Do not pass a BullMQ provider or Redis Stream client to the SDK.

Follow the complete, file-by-file instructions in
[the host integration walkthrough](host/README.md).

The host supplies only `CREDIT_REDIS_CLIENT`. The SDK creates and closes its
own duplicated Stream and BullMQ connections.

## Run the external event server

```sh
npm run start:example:events
```

Continue with [the event-server walkthrough](event-server/README.md) to grant
two plans, exercise PROD/DEV requests in the real host, and inspect lifecycle
events.

For a complete explanation of every step, see the
[developer guide](../docs/developer-guide.md#start-here-complete-integration).
