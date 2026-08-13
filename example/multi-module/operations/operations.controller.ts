import {
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import { CreditService } from '../../../src';
import {
  MULTI_MODULE_SUBJECT,
} from '../billing/multi-balance.provider';

@Controller({ path: 'operations', version: '1' })
export class OperationsController {
  constructor(private readonly credits: CreditService) {}

  @Get('balance')
  async balance() {
    return {
      subject: MULTI_MODULE_SUBJECT,
      balance: await this.credits.getBalance(MULTI_MODULE_SUBJECT),
    };
  }

  @Post('grant')
  grant(@Body() body: { amount?: number; referenceId?: string }) {
    return this.credits.grant({
      subject: MULTI_MODULE_SUBJECT,
      amount: body.amount ?? 25,
      referenceId: body.referenceId ?? 'demo-payment-1',
      reason: 'demo_credit_purchase',
    });
  }
}
