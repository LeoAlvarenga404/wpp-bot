import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/wa.module';
import { BaileysPublisher } from './baileys.publisher';
import { PUBLISHERS } from './publisher.port';
import { PublisherRegistry } from './publisher-registry.service';
import { TelegramPublisher } from './telegram.publisher';

@Module({
  imports: [WhatsappModule],
  providers: [
    BaileysPublisher,
    TelegramPublisher,
    {
      provide: PUBLISHERS,
      inject: [BaileysPublisher, TelegramPublisher],
      useFactory: (...pubs: unknown[]) => pubs,
    },
    PublisherRegistry,
  ],
  exports: [PublisherRegistry],
})
export class PublisherModule {}
