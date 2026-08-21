import 'reflect-metadata';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MultiModuleAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(MultiModuleAppModule);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`Multi-module demo: http://localhost:${port}/api/v1`);
  console.log(
    'Use headers: x-business-id, x-request-id, x-service-environment: PROD|DEV',
  );
}

void bootstrap();
