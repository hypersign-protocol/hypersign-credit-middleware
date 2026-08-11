import { Controller, Post } from '@nestjs/common';
import { CreditCost } from './credit.decorator';

@Controller('demo')
export class DemoController {
  @Post('success')
  @CreditCost(20)
  success() {
    return { success: true };
  }

  @Post('fail')
  @CreditCost(20)
  fail(): never {
    throw new Error('Demo failure');
  }
}
