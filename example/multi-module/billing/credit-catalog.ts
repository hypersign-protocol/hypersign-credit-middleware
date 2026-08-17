import { defineCreditCatalog } from '../../../src';

export const FETCH_FLOW_COST = 10;
export const CREATE_REPORT_COST = 5;

export const KYC_CREDIT_CATALOG = defineCreditCatalog({
  serviceId: 'kyc',
  version: '1',
  globalPrefix: 'api',
  routes: [
    {
      method: 'GET',
      path: '/api/v1/mobile-flows/:flowId',
      boundary: true,
      charges: [{ id: 'api', creditType: 'API_CREDIT', amount: FETCH_FLOW_COST }],
    },
    {
      method: 'POST',
      path: '/api/v1/reports',
      charges: [{ id: 'api', creditType: 'API_CREDIT', amount: CREATE_REPORT_COST }],
    },
    { method: 'GET', path: '/api/v1/operations/balance', charges: [] },
  ],
});
