import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Demo server listening on http://localhost:${port}`);
  console.log('Start with GET /demo/balance and POST /demo/cheap');
  console.log('Two-credit demo: POST /demo/blockchain-operation');
  console.log('Send x-demo-stop-before-controller: true to test early rollback');
}

void bootstrap();
