import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { EnrichmentService } from './enrichment.service';
import { SellerCacheService } from './seller-cache.service';

@Module({
  imports: [HttpModule, MercadoLivreModule],
  providers: [SellerCacheService, EnrichmentService],
  exports: [EnrichmentService, SellerCacheService],
})
export class EnrichmentModule {}
