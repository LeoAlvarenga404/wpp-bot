import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateManualDealDto } from './create-manual-deal.dto';

async function errs(obj: unknown) {
  return validate(plainToInstance(CreateManualDealDto, obj));
}

describe('CreateManualDealDto', () => {
  const base = {
    store: 'ml',
    title: 'Fone JBL',
    priceCents: 17900,
    thumbnail: 'https://http2.mlstatic.com/x.jpg',
  };

  it('accepts a minimal deal without a link', async () => {
    expect(await errs(base)).toHaveLength(0);
  });

  it('accepts a full deal with coupon, link and dispatch', async () => {
    expect(
      await errs({
        ...base,
        originalPriceCents: 29900,
        installmentsNoInterest: true,
        coupon: { code: 'JBL20', finalCents: 15000 },
        permalink: 'https://www.mercadolivre.com.br/p/MLB1',
        dispatch: true,
      }),
    ).toHaveLength(0);
  });

  it('rejects a non-positive price', async () => {
    expect((await errs({ ...base, priceCents: 0 })).length).toBeGreaterThan(0);
  });

  it('rejects a thumbnail that is not an http url', async () => {
    expect(
      (await errs({ ...base, thumbnail: 'not-a-url' })).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a permalink that is present but not an http url', async () => {
    expect(
      (await errs({ ...base, permalink: 'ftp://x' })).length,
    ).toBeGreaterThan(0);
  });
});
