# Integration examples

This folder contains SDK integration examples. It is excluded from the
published npm package.

| Directory | Role |
| --- | --- |
| [`host/`](host/README.md) | Example NestJS modules for registering the SDK. |
| [`event-server/`](event-server/README.md) | Example server for granting plans and receiving lifecycle events. |

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
