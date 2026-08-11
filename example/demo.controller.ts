import {
  BadRequestException, Body, Controller, Get, Inject, Logger, Param, Post, Req,
} from '@nestjs/common';
import Redis from 'ioredis';
import {
  CREDIT_REDIS_CLIENT,
  CreditCost,
  CreditRecoveryService,
  CreditService,
} from '../src';
import { Cron } from '@nestjs/schedule';

interface ResetBalanceBody {
  amount?: number;
}

interface DemoRequest { requestId: string }

@Controller('demo')
export class ExampleDemoController {
  constructor(
    private readonly credits: CreditService,
    private readonly recovery: CreditRecoveryService,
    @Inject(CREDIT_REDIS_CLIENT) private readonly redis: Redis,
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
      accountId: 'user_123',
      balance: await this.credits.getBalance('user_123'),
    };
  }

  /** Inspect the durable state retained after commit, rollback, or expiry. */
  @Get('reservations/:reservationId')
  async reservation(@Param('reservationId') reservationId: string) {
    return await this.credits.getReservation(reservationId) ?? { found: false };
  }

  /** Reset the playground between experiments. Defaults to 100 credits. */
  @Post('reset')
  async reset(@Body() body: ResetBalanceBody = {}) {
    const amount = body.amount ?? 100;
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new BadRequestException('amount must be a non-negative safe integer');
    }

    await this.redis.set('credit:balance:user_123', amount);
    return { accountId: 'user_123', balance: amount };
  }

  /** Create an intentionally abandoned reservation for recovery experiments. */
  @Post('orphan')
  async orphan(@Req() request: DemoRequest) {
    return this.credits.reserve({
      accountId: 'user_123',
      requestId: request.requestId,
      serviceId: 'recovery-demo',
      amount: 15,
    });
  }

  /** Manually run one recovery pass (production should use an external worker). */
  @Post('recover')
  async recover() {
    return { recovered: await this.recovery.runOnce() };
  }

  /** Successful low-cost request: 100 becomes 90. */
  @Post('cheap')
  @CreditCost(10)
  async cheap() {
    return {
      success: true,
      cost: 10,
      balanceDuringController: await this.credits.getBalance('user_123'),
    };
  }

  /** Successful high-cost request, useful for concurrency experiments. */
  @Post('expensive')
  @CreditCost(70)
  async expensive() {
    return {
      success: true,
      cost: 70,
      balanceDuringController: await this.credits.getBalance('user_123'),
    };
  }

  /** Reserves 20, throws, and should have all 20 rolled back. */
  @Post('fail')
  @CreditCost(20)
  fail(): never {
    throw new Error('Intentional demo failure');
  }



  @Cron('*/60 * * * * *')
  async cronRecover() {
    const recovered = await this.recovery.runOnce();
    Logger.log(`Cron job ran; recovered ${recovered} expired reservations`);
    if (recovered > 0) {
      console.log(`Cron recovered ${recovered} expired reservations`);
    }
  }

}




