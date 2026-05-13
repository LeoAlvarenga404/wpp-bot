import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global DB module — exposes PrismaService everywhere without per-module
 * imports. Lands as scaffold for P1-9; existing file-backed services will be
 * refactored to use this in a follow-up task.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DbModule {}
