import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AffiliateModule } from './affiliate/affiliate.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MercadoLivreModule } from './mercado-livre/ml.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { WhatsappModule } from './whatsapp/wa.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MercadoLivreModule,
    WhatsappModule,
    AffiliateModule,
    PipelineModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
