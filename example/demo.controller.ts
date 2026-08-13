import {
  Controller, Get, Param, Post, Req,
} from '@nestjs/common';
import {
  CreditCost,
  CreditRecoveryService,
  CreditService,
} from '../src';
import {
  BLOCKCHAIN_API_CREDIT_POLICY,
  BLOCKCHAIN_TRANSACTION_COST,
  BLOCKCHAIN_TRANSACTION_SUBJECT,
  CHEAP_CREDIT_POLICY,
  EXAMPLE_ACCOUNT_ID,
  EXAMPLE_SUBJECT,
  exampleBalanceProvider,
} from './credit-demo.config';

interface DemoRequest { requestId: string }

@Controller('demo')
export class ExampleDemoController {
  constructor(
    private readonly credits: CreditService,
    private readonly recovery: CreditRecoveryService,
  ) {}

  /** No @CreditCost: useful for checking that undecorated routes remain free. */
  @Get('free')
  free() {
    return {
      success: true,
      message: 'This endpoint does not reserve credits',
      cost: 0,
    };
  }

  /** Read the current balance without spending credits. */
  @Get('balance')
  async balance() {
    return {
      accountId: EXAMPLE_ACCOUNT_ID,
      balances: {
        API_CREDIT: await this.credits.getBalance(EXAMPLE_SUBJECT),
        BLOCKCHAIN_TXN_CREDIT: await this.credits.getBalance(
          BLOCKCHAIN_TRANSACTION_SUBJECT,
        ),
      },
    };
  }

  /** Inspect the durable state retained after commit, rollback, or expiry. */
  @Get('reservations/:reservationId')
  async reservation(@Param('reservationId') reservationId: string) {
    return await this.credits.getReservation(reservationId) ?? { found: false };
  }

  /** Create an intentionally abandoned reservation for recovery experiments. */
  @Post('orphan')
  async orphan(@Req() request: DemoRequest) {
    return this.credits.reserve({
      subject: EXAMPLE_SUBJECT,
      requestId: request.requestId,
      amount: 15,
    });
  }

  /** Programmatic/deferred: caller settles this reservation later. */
  @Post('deferred')
  async deferred(@Req() request: DemoRequest) {
    return this.credits.reserve({
      subject: EXAMPLE_SUBJECT,
      requestId: `${request.requestId}:deferred`,
      operation: 'DEFERRED_DEMO',
      amount: 25,
      settlementMode: 'DEFERRED',
    });
  }

  /**
   * One business operation with two independent credit lifecycles:
   * - the decorator commits 5 API_CREDIT after this handler succeeds;
   * - the manual reservation emits a RESERVED event and remains DEFERRED.
   *
   * This demo intentionally has no worker. The reservation opts out of
   * scheduled recovery and must eventually be committed or rolled back by its
   * owner. The configured event handler logs its RESERVED event.
   */
  @Post('blockchain-operation')
  @CreditCost(BLOCKCHAIN_API_CREDIT_POLICY)
  async blockchainOperation(@Req() request: DemoRequest) {
    await this.credits.reserve({
      subject: BLOCKCHAIN_TRANSACTION_SUBJECT,
      requestId: `${request.requestId}:blockchain-transaction`,
      operation: 'EXECUTE_BLOCKCHAIN_TRANSACTION',
      amount: BLOCKCHAIN_TRANSACTION_COST,
      settlementMode: 'DEFERRED',
      autoRecover: false,
    });

    return {};
  }

  @Post('deferred/:reservationId/commit')
  commitDeferred(@Param('reservationId') id: string) {
    return this.credits.commit(id);
  }

  @Post('deferred/:reservationId/rollback')
  rollbackDeferred(@Param('reservationId') id: string) {
    return this.credits.rollback(id, 'deferred_operation_failed');
  }

  @Get('provider-calls')
  providerCalls() {
    return { calls: exampleBalanceProvider.calls };
  }

  /** Manually run one recovery pass (production should use an external worker). */
  @Post('recover')
  async recover() {
    return { recovered: await this.recovery.runOnce() };
  }

  /** Successful low-cost request: 100 becomes 90. */
  @Post('cheap')
  @CreditCost(CHEAP_CREDIT_POLICY)
  async cheap() {
    return {
      success: true,
      cost: 10,
      balanceDuringController: await this.credits.getBalance(EXAMPLE_SUBJECT),
    };
  }

  /** Successful high-cost request, useful for concurrency experiments. */
  @Post('expensive')
  @CreditCost(70)
  async expensive() {
    return {
      success: true,
      cost: 70,
      balanceDuringController: await this.credits.getBalance(EXAMPLE_SUBJECT),
    };
  }

  /** Reserves 20, throws, and should have all 20 rolled back. */
  @Post('fail')
  @CreditCost(20)
  fail(): never {
    throw new Error('Intentional demo failure');
  }
}
