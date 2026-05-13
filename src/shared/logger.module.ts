/**
 * Pre-configured LoggerModule for the app to import (P0-7).
 *
 * Consumers should add `SharedLoggerModule` to `app.module.ts` imports so the
 * nestjs-pino logger is wired with our redaction + pretty-print policy.
 */

import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { buildPinoOptions } from './logger';

@Module({
  imports: [LoggerModule.forRoot(buildPinoOptions())],
  exports: [LoggerModule],
})
export class SharedLoggerModule {}
