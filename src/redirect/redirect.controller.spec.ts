import { NotFoundException } from '@nestjs/common';
import { RedirectController } from './redirect.controller';
import type { RedirectService } from './redirect.service';

function makeService(overrides: Partial<RedirectService> = {}) {
  return {
    resolve: jest.fn().mockResolvedValue(null),
    trackClick: jest.fn(),
    ...overrides,
  } as unknown as RedirectService & {
    resolve: jest.Mock;
    trackClick: jest.Mock;
  };
}

describe('RedirectController', () => {
  it('302-redirects to the stored url for a known code', async () => {
    const service = makeService();
    service.resolve.mockResolvedValue({
      code: 'abc1234',
      url: 'https://meli.la/ABC',
    });
    const controller = new RedirectController(service);

    const out = await controller.follow('abc1234');

    expect(out).toEqual({ url: 'https://meli.la/ABC' });
  });

  it('increments clicks without blocking the redirect', async () => {
    const service = makeService();
    service.resolve.mockResolvedValue({ code: 'abc1234', url: 'https://x' });
    const controller = new RedirectController(service);

    await controller.follow('abc1234');

    expect(service.trackClick).toHaveBeenCalledWith('abc1234');
  });

  it('404s for an unknown code and does not track a click', async () => {
    const service = makeService();
    const controller = new RedirectController(service);

    await expect(controller.follow('nope')).rejects.toThrow(NotFoundException);
    expect(service.trackClick).not.toHaveBeenCalled();
  });
});
