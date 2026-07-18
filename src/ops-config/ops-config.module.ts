import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { OpsConfigController } from './ops-config.controller';
import { OpsConfigRepo } from './ops-config.repo';
import { OpsConfigService } from './ops-config.service';

@Module({
  imports: [DbModule],
  controllers: [OpsConfigController],
  providers: [OpsConfigRepo, OpsConfigService],
  exports: [OpsConfigService],
})
export class OpsConfigModule {}
