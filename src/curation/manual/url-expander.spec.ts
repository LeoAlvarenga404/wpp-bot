import { HttpShortUrlExpander, isShortMeliUrl } from './url-expander';

describe('isShortMeliUrl', () => {
  it('recognizes meli.la short links', () => {
    expect(isShortMeliUrl('https://meli.la/x9Kq2')).toBe(true);
  });
  it('ignores full product links', () => {
    expect(isShortMeliUrl('https://www.mercadolivre.com.br/p/MLB123')).toBe(
      false,
    );
  });
});

describe('HttpShortUrlExpander', () => {
  const finalUrl = 'https://www.mercadolivre.com.br/p/MLB123?ref=x';

  it('returns the final URL after following the redirect', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      url: finalUrl,
      ok: true,
    } as Response);
    const exp = new HttpShortUrlExpander(fetchFn, 5000);
    await expect(exp.expand('https://meli.la/x9Kq2')).resolves.toBe(finalUrl);
  });

  it('falls back to the original URL when fetch throws', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('network'));
    const exp = new HttpShortUrlExpander(fetchFn, 5000);
    await expect(exp.expand('https://meli.la/x9Kq2')).resolves.toBe(
      'https://meli.la/x9Kq2',
    );
  });

  it('falls back to the original URL when the response has no url', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue({ url: '', ok: true } as Response);
    const exp = new HttpShortUrlExpander(fetchFn, 5000);
    await expect(exp.expand('https://meli.la/x9Kq2')).resolves.toBe(
      'https://meli.la/x9Kq2',
    );
  });
});
