import { Inject, Injectable } from '@nestjs/common';
import type { Channel } from '../whatsapp/targets.service';
import { PUBLISHERS } from './publisher.port';
import type { PublisherPort } from './publisher.port';

@Injectable()
export class PublisherRegistry {
  private readonly byChannel = new Map<Channel, PublisherPort>();

  constructor(@Inject(PUBLISHERS) publishers: PublisherPort[]) {
    for (const p of publishers) this.byChannel.set(p.channel, p);
  }

  get(channel: Channel): PublisherPort {
    const p = this.byChannel.get(channel);
    if (!p) throw new Error(`no publisher for channel=${channel}`);
    return p;
  }
}
