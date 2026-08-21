import { Global, Module, UnauthorizedException } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import {
  CreditEnvironment,
  CreditModule,
} from '../../src';
import { CreditInfrastructureModule } from './credit-infrastructure.module';
import { CreditRecoveryScheduler } from './credit-recovery.scheduler';

interface TrustedServiceRequest {
  service?: {
    appId?: string;
    subdomain?: string;
    env?: string;
  };
  requestId?: string;
}

@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    CreditInfrastructureModule,
    CreditModule.forRootAsync({
      imports: [CreditInfrastructureModule],
      useFactory: () => ({
        requestContextResolver: (unknownRequest: unknown) => {
          const request = unknownRequest as TrustedServiceRequest;
          const environment = request.service?.env?.trim().toUpperCase();
          if (environment !== 'PROD' && environment !== 'DEV') {
            throw new UnauthorizedException(
              'Trusted service environment must be PROD or DEV',
            );
          }

          return {
            subject: {
              tenantId: request.service?.subdomain,
              appId: request.service?.appId ?? '',
              appType: 'CAVACH_API',
              creditType: 'API_CREDIT',
            },
            requestId: request.requestId,
            environment: environment as CreditEnvironment,
          };
        },
      }),
    }),
  ],
  providers: [CreditRecoveryScheduler],
  exports: [CreditModule],
})
export class CreditIntegrationModule {}
