import { Module } from '@nestjs/common';
import { WhatsappService } from './wa.service';

@Module({
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
