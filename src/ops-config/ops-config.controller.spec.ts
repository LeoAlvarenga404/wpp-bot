import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OpsConfigController } from './ops-config.controller';
import type { OpsConfigService } from './ops-config.service';
import { SetOpsConfigDto } from './dto/set-ops-config.dto';

function makeService(): OpsConfigService {
  return {
    getAllEffective: jest.fn(async () => [
      { key: 'AUTO_APPROVE_SCORE', value: '999', source: 'default' },
    ]),
    set: jest.fn(async (key: string) => {
      if (key === 'NOT_A_KEY') throw new BadRequestException('unknown key');
    }),
  } as unknown as OpsConfigService;
}

describe('SetOpsConfigDto', () => {
  it('accepts a plain string value', async () => {
    const dto = plainToInstance(SetOpsConfigDto, { value: '85' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a missing value', async () => {
    const dto = plainToInstance(SetOpsConfigDto, {});
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('OpsConfigController', () => {
  it('GET returns every known key with effective value and source', async () => {
    const controller = new OpsConfigController(makeService());
    await expect(controller.getAll()).resolves.toEqual({
      values: [{ key: 'AUTO_APPROVE_SCORE', value: '999', source: 'default' }],
    });
  });

  it('PUT delegates to the service and echoes the new effective config', async () => {
    const svc = makeService();
    const controller = new OpsConfigController(svc);
    const dto = plainToInstance(SetOpsConfigDto, { value: '85' });

    await controller.set('AUTO_APPROVE_SCORE', dto);

    expect(svc.set).toHaveBeenCalledWith('AUTO_APPROVE_SCORE', '85');
  });

  it('PUT surfaces the service rejection for an unknown key', async () => {
    const controller = new OpsConfigController(makeService());
    const dto = plainToInstance(SetOpsConfigDto, { value: '1' });
    await expect(controller.set('NOT_A_KEY', dto)).rejects.toThrow(
      BadRequestException,
    );
  });
});
