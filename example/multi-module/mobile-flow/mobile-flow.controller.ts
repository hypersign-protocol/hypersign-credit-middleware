import { Controller, Get, Param } from '@nestjs/common';
import { CreditCost } from '../../../src';
import { FETCH_FLOW_CREDIT } from '../billing/credit-policies';

@Controller({ path: 'mobile-flows', version: '1' })
export class MobileFlowController {
  @Get(':flowId')
  @CreditCost(FETCH_FLOW_CREDIT)
  findOne(@Param('flowId') flowId: string) {
    return { flowId, status: 'READY', charged: FETCH_FLOW_CREDIT.amount };
  }
}
