import { Controller, Get } from '@nestjs/common';
import { CreditService } from '../../../src';
import {
  MULTI_MODULE_SUBJECT,
} from '../billing/credit-subject';

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

}
