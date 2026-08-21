# Integration examples

These files are maintained in the repository and excluded from the published
npm package.

| Directory | Role |
| --- | --- |
| [`host/`](host/README.md) | NestJS modules for the CAVACH API that owns the complete bundled route catalog. |
| [`event-server/`](event-server/README.md) | External process that publishes plan grants and consumes lifecycle events. |

The SDK audits the complete NestJS route table at startup. Integrate the host
modules into the CAVACH API; this repository does not provide a partial API
server.

## Build

```sh
npm run build:example
```

## API host

Follow [the host file reference](host/README.md) to:

1. register `CREDIT_REDIS_CLIENT`;
2. import `CreditModule`;
3. map authenticated request data to a credit wallet;
4. schedule recovery every five minutes; and
5. verify `prod` deduction and `dev` observation behavior.

The host supplies no BullMQ provider or Redis Stream client. The SDK creates
those connections from the supplied Redis client.

## Grant and lifecycle service

Start the external process:

```sh
npm run start:example:events
```

Use the [event-server reference](event-server/README.md) to grant plans and
inspect lifecycle events.

The [integration guide](../docs/integration-guide.md) contains the full setup
and verification sequence. The [developer reference](../docs/developer-guide.md)
documents configuration, messages, storage, and operations.
