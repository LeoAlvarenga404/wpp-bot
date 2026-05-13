import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MercadoLivreAuthService } from './ml-auth.service';
import { MercadoLivreService } from './ml.service';
import { OAuthController } from './oauth.controller';

@Module({
  imports: [HttpModule],
  controllers: [OAuthController],
  providers: [MercadoLivreAuthService, MercadoLivreService],
  exports: [MercadoLivreService, MercadoLivreAuthService],
})
export class MercadoLivreModule {}
