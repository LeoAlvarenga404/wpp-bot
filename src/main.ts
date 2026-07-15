import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { initSentry } from './shared/sentry';

async function bootstrap() {
  // Must come before NestFactory so early errors are captured.
  initSentry();

  // ApiKeyGuard silently passes requests through when API_KEY is unset (dev
  // convenience). In production that would leave every guarded endpoint open,
  // so refuse to boot instead.
  if (process.env.NODE_ENV === 'production' && !process.env.API_KEY) {
    throw new Error('API_KEY must be set when NODE_ENV=production');
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`wpp-bot listening on :${port}`, 'Bootstrap');
}

void bootstrap();
