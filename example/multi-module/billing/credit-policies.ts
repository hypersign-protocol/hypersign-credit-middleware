import { CreditCostOptions, EarlyCreditPolicy } from '../../../src';

/** One contract is reused by the boundary policy and controller decorator. */
export const FETCH_FLOW_CREDIT: CreditCostOptions = {
  amount: 10,
  settlementMode: 'IMMEDIATE',
  operation: 'FETCH_MOBILE_FLOW',
};

export const CREATE_REPORT_CREDIT: CreditCostOptions = {
  amount: 5,
  settlementMode: 'IMMEDIATE',
  operation: 'CREATE_REPORT',
};

export const EARLY_CREDIT_POLICIES: EarlyCreditPolicy[] = [
  {
    method: 'GET',
    // originalUrl includes the global prefix and URI version.
    path: '/api/v1/mobile-flows/:flowId',
    ...FETCH_FLOW_CREDIT,
  },
];
