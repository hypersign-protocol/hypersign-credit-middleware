# Redis credit reservation POC

The host application provides and exports its existing Redis client under the
`REDIS_CLIENT` token, then imports `CreditModule`. The client must support the
common `eval(script, numberOfKeys, ...args)` signature. For example, a global
Redis infrastructure module can expose it as follows:

```ts
@Global()
@Module({
  providers: [
    {
      provide: CREDIT_REDIS_CLIENT, // its value is "REDIS_CLIENT"
      useValue: existingRedisClient,
    },
  ],
  exports: [CREDIT_REDIS_CLIENT],
})
export class RedisInfrastructureModule {}
```

Import `RedisInfrastructureModule` before `CreditModule` in the root module.

Add `DemoController` to an application module's `controllers` array. A guard or
middleware must set `request.user.id` and `request.requestId` before the global
interceptor runs.

Seed the demo account with:

```sh
redis-cli SET credit:balance:user_123 100
```

The Lua reserve operation checks and decrements the balance and creates the
reservation atomically. Success deletes the reservation; failure atomically
refunds it once and deletes it.

## Run the example server

Start Redis locally on port 6379, then run:

```sh
npm install
npm run start:example
```

The example uses `redis://localhost:6379` by default and initializes
`credit:balance:user_123` to `100` only when the key does not already exist.
Both settings can be overridden:

```sh
REDIS_URL=redis://localhost:6379 PORT=3000 npm run start:example
```

The example is a small playground with these routes:

| Method | Route | Credit cost | Purpose |
| --- | --- | ---: | --- |
| GET | `/demo/free` | 0 | Verify undecorated routes bypass credit handling |
| GET | `/demo/balance` | 0 | Inspect the current Redis balance |
| POST | `/demo/reset` | 0 | Reset balance; JSON body defaults to `{ "amount": 100 }` |
| POST | `/demo/orphan` | 15 | Create an abandoned reservation for recovery testing |
| POST | `/demo/recover` | 0 | Manually run one expired-reservation recovery pass |
| POST | `/demo/cheap` | 10 | Successful low-cost reservation and commit |
| POST | `/demo/expensive` | 70 | High-cost route for concurrent-request experiments |
| POST | `/demo/fail` | 20 | Force a controller error and rollback |
| GET | `/demo/reservations/:id` | 0 | Inspect retained reservation state |

Try a normal commit and a rollback:

```sh
curl -s http://localhost:3000/demo/balance
curl -s -X POST http://localhost:3000/demo/cheap
curl -s http://localhost:3000/demo/balance

curl -i -X POST http://localhost:3000/demo/fail
curl -s http://localhost:3000/demo/balance
```

Test crash recovery without actually killing the server. `/demo/orphan` makes a
manual reservation and deliberately never commits or rolls it back. The example
lease is 10 seconds. After it expires, manually invoke recovery:

```sh
curl -s -X POST http://localhost:3000/demo/reset
curl -s -X POST http://localhost:3000/demo/orphan
# Copy reservationId from the response, then observe balance 85.
curl -s http://localhost:3000/demo/balance
sleep 12
curl -s -X POST http://localhost:3000/demo/recover
# Recovery changes the state to EXPIRED and restores balance to 100.
curl -s http://localhost:3000/demo/balance
curl -s http://localhost:3000/demo/reservations/PASTE_RESERVATION_ID
```

Finalized reservation hashes and request-id mappings are retained for one hour
in the example. The library defaults to seven days.

The library creates no timers. Reservations use a fixed lease. Production
deployments should call `CreditRecoveryService.runOnce()` from a separate cron
job or worker so recovery still runs when API instances crash. Applications
with legitimate operations longer than `leaseMs` must call
`CreditService.renew(reservationId)` explicitly from that long-running job.

Reset to 100 and send two 70-credit requests at the same time. Exactly one
should succeed and the other should receive an insufficient-credit response:

```sh
curl -s -X POST http://localhost:3000/demo/reset \
  -H 'content-type: application/json' \
  -d '{"amount":100}'

curl -s -X POST http://localhost:3000/demo/expensive &
curl -s -X POST http://localhost:3000/demo/expensive &
wait

curl -s http://localhost:3000/demo/balance
```
