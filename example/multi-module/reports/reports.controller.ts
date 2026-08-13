import { Body, Controller, Post } from '@nestjs/common';
import { CreditCost } from '../../../src';
import { CREATE_REPORT_CREDIT } from '../billing/credit-policies';

@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  @Post()
  @CreditCost(CREATE_REPORT_CREDIT)
  create(@Body() body: { name?: string }) {
    return { id: 'report_1', name: body?.name ?? 'untitled', charged: 5 };
  }
}
