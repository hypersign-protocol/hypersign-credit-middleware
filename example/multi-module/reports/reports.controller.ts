import { Body, Controller, Post } from '@nestjs/common';
import { CREATE_REPORT_COST } from '../billing/credit-catalog';

@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  @Post()
  create(@Body() body: { name?: string }) {
    return {
      id: 'report_1',
      name: body?.name ?? 'untitled',
      charged: CREATE_REPORT_COST,
    };
  }
}
