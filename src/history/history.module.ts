import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

@Module({
  imports: [DbModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}
