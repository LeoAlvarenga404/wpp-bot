import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { initSentry } from './shared/sentry';

async function bootstrap() {
  // Must come before NestFactory so early errors are captured.
  initSentry();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`wpp-bot listening on :${port}`, 'Bootstrap');
}

void bootstrap();
