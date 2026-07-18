import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { APPROVAL_QUEUE_REPO, type ApprovalQueueRepo, type PendingDealRow } from './approval-queue.repo';
import { DmAlertService } from './dm-alert.service';
import { OpsConfigService } from '../ops-config/ops-config.service';
import { PublisherRegistry } from '../publisher/publisher-registry.service';

class TestDmAlertService extends DmAlertService {
  public testNow = new Date('2023-01-01T12:00:00Z');
  
  protected now(): Date {
    return this.testNow;
  }
}

describe('DmAlertService', () => {
  let service: TestDmAlertService;
  let repo: jest.Mocked<ApprovalQueueRepo>;
  let opsConfig: jest.Mocked<OpsConfigService>;
  let config: jest.Mocked<ConfigService>;
  let publishers: jest.Mocked<PublisherRegistry>;
  let publisherPort: any;

  beforeEach(async () => {
    repo = {
      listPending: jest.fn(),
    } as any;

    opsConfig = {
      operatorJid: jest.fn().mockResolvedValue('5511999999999@s.whatsapp.net'),
      dmBatchIntervalMin: jest.fn().mockResolvedValue(30),
      quietHoursEnabled: jest.fn().mockResolvedValue(false),
    } as any;

    config = {
      get: jest.fn((key) => {
        if (key === 'PANEL_URL') return 'http://test-panel';
        return undefined;
      }),
    } as any;

    publisherPort = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    publishers = {
      get: jest.fn().mockReturnValue(publisherPort),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: DmAlertService, useClass: TestDmAlertService },
        { provide: APPROVAL_QUEUE_REPO, useValue: repo },
        { provide: OpsConfigService, useValue: opsConfig },
        { provide: ConfigService, useValue: config },
        { provide: PublisherRegistry, useValue: publishers },
      ],
    }).compile();

    service = module.get<DmAlertService>(DmAlertService) as TestDmAlertService;
  });

  it('skips if OPERATOR_JID is empty', async () => {
    opsConfig.operatorJid.mockResolvedValue('');
    await service.checkAndSendAlert();
    expect(repo.listPending).not.toHaveBeenCalled();
  });

  it('skips if dm batch interval has not elapsed yet', async () => {
    // first run
    repo.listPending.mockResolvedValue([
      { createdAt: new Date('2023-01-01T11:59:00Z'), expiresAt: new Date('2023-01-01T15:00:00Z') } as PendingDealRow,
    ]);
    await service.checkAndSendAlert();
    expect(publisherPort.publish).toHaveBeenCalledTimes(1);
    
    publisherPort.publish.mockClear();
    repo.listPending.mockClear();

    // second run 10 mins later (interval is 30)
    service.testNow = new Date(service.testNow.getTime() + 10 * 60_000);
    await service.checkAndSendAlert();
    expect(repo.listPending).not.toHaveBeenCalled();
    expect(publisherPort.publish).not.toHaveBeenCalled();
  });

  it('skips during quiet hours', async () => {
    opsConfig.quietHoursEnabled.mockResolvedValue(true);
    config.get.mockImplementation((k) => {
      if (k === 'QUIET_START') return '23';
      if (k === 'QUIET_END') return '7';
      if (k === 'TZ') return 'America/Sao_Paulo';
      return undefined;
    });
    // UTC 04:00 is 01:00 AM in America/Sao_Paulo (UTC-3)
    service.testNow = new Date('2023-01-01T04:00:00Z'); 
    
    // Simulate interval elapsed by forcing lastAlertSentAt = 0 (default)
    await service.checkAndSendAlert();
    
    expect(repo.listPending).not.toHaveBeenCalled();
    expect(publisherPort.publish).not.toHaveBeenCalled();
  });

  it('skips if no pending deals', async () => {
    repo.listPending.mockResolvedValue([]);
    await service.checkAndSendAlert();
    expect(publisherPort.publish).not.toHaveBeenCalled();
  });

  it('skips if no new deals since last alert', async () => {
    repo.listPending.mockResolvedValue([
      { createdAt: new Date('2023-01-01T11:00:00Z'), expiresAt: new Date('2023-01-01T15:00:00Z') } as PendingDealRow,
    ]);
    
    await service.checkAndSendAlert(); // sets lastAlertSentAt to testNow
    expect(publisherPort.publish).toHaveBeenCalledTimes(1);

    publisherPort.publish.mockClear();

    // advance time 31 mins
    service.testNow = new Date(service.testNow.getTime() + 31 * 60_000);
    
    // still same deals (createdAt is older than lastAlertSentAt)
    await service.checkAndSendAlert();
    expect(publisherPort.publish).not.toHaveBeenCalled(); // skips without spamming
  });

  it('sends alert if there are new deals', async () => {
    repo.listPending.mockResolvedValue([
      { createdAt: new Date('2023-01-01T11:00:00Z'), expiresAt: new Date('2023-01-01T15:00:00Z') } as PendingDealRow,
    ]);
    
    await service.checkAndSendAlert();
    expect(publisherPort.publish).toHaveBeenCalledTimes(1);

    publisherPort.publish.mockClear();
    const alert1Time = service.testNow.getTime();

    // advance time 31 mins
    service.testNow = new Date(service.testNow.getTime() + 31 * 60_000);
    
    // add a new deal created after alert1
    repo.listPending.mockResolvedValue([
      { createdAt: new Date('2023-01-01T11:00:00Z'), expiresAt: new Date('2023-01-01T15:00:00Z') } as PendingDealRow,
      { createdAt: new Date(alert1Time + 5 * 60_000), expiresAt: new Date('2023-01-01T16:00:00Z') } as PendingDealRow,
    ]);

    await service.checkAndSendAlert();
    expect(publisherPort.publish).toHaveBeenCalledTimes(1);
    expect(publisherPort.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: expect.stringContaining('2 deals aguardando'),
      }),
      '5511999999999@s.whatsapp.net'
    );
  });

  it('counts correctly how many deals expire soon', async () => {
    repo.listPending.mockResolvedValue([
      // expires in 30 mins (soon)
      { createdAt: new Date('2023-01-01T11:59:00Z'), expiresAt: new Date(service.testNow.getTime() + 30 * 60_000) } as PendingDealRow,
      // expires in 90 mins (not soon)
      { createdAt: new Date('2023-01-01T11:59:00Z'), expiresAt: new Date(service.testNow.getTime() + 90 * 60_000) } as PendingDealRow,
      // already expired (should technically not be here, but count it)
      { createdAt: new Date('2023-01-01T11:59:00Z'), expiresAt: new Date(service.testNow.getTime() - 10 * 60_000) } as PendingDealRow,
    ]);

    await service.checkAndSendAlert();
    
    expect(publisherPort.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: expect.stringMatching(/3 deals aguardando \(2 expiram em breve\)/),
      }),
      expect.any(String)
    );
  });
});
