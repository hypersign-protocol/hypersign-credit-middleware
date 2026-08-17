import { Controller, Get, Param } from '@nestjs/common';
import { FETCH_FLOW_COST } from '../billing/credit-catalog';

@Controller({ path: 'mobile-flows', version: '1' })
export class MobileFlowController {
  @Get(':flowId')
  findOne(@Param('flowId') flowId: string) {
    return { flowId, status: 'READY', charged: FETCH_FLOW_COST };
  }
}
