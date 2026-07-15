import axios from 'axios';
import { TelegramPublisher } from './telegram.publisher';

jest.mock('axios', () => ({
  post: jest.fn(),
  isAxiosError: jest.fn((e: any) => !!e?.isAxiosError),
}));
const mockedPost = axios.post as jest.Mock;

function makeConfig(token = 'TOKEN123') {
  return {
    get: jest.fn().mockImplementation((_k: string, def?: string) => {
      return token !== '' ? token : (def ?? '');
    }),
  } as any;
}

function axiosError(status: number) {
  return { isAxiosError: true, response: { status } };
}

describe('TelegramPublisher', () => {
  beforeEach(() => mockedPost.mockReset());

  it('sends photo with Markdown caption when imageUrl present', async () => {
    mockedPost.mockResolvedValue({ data: { ok: true } });
    const pub = new TelegramPublisher(makeConfig());
    await pub.publish({ caption: '*oi*', imageUrl: 'https://img' }, '-100555');
    expect(mockedPost).toHaveBeenCalledWith(
      'https://api.telegram.org/botTOKEN123/sendPhoto',
      expect.objectContaining({
        chat_id: '-100555',
        photo: 'https://img',
        caption: '*oi*',
        parse_mode: 'Markdown',
      }),
    );
  });

  it('sends text message when no image', async () => {
    mockedPost.mockResolvedValue({ data: { ok: true } });
    const pub = new TelegramPublisher(makeConfig());
    await pub.publish({ caption: 'oi' }, '-100555');
    expect(mockedPost).toHaveBeenCalledWith(
      'https://api.telegram.org/botTOKEN123/sendMessage',
      expect.objectContaining({
        chat_id: '-100555',
        text: 'oi',
        parse_mode: 'Markdown',
      }),
    );
  });

  it('retries without parse_mode on 400 (bad markdown entities)', async () => {
    mockedPost
      .mockRejectedValueOnce(axiosError(400))
      .mockResolvedValueOnce({ data: { ok: true } });
    const pub = new TelegramPublisher(makeConfig());
    await pub.publish({ caption: 'a_b*c' }, '-100555');
    expect(mockedPost).toHaveBeenCalledTimes(2);
    const secondBody = mockedPost.mock.calls[1][1];
    expect(secondBody.parse_mode).toBeUndefined();
  });

  it('maps 429 to throttled:telegram', async () => {
    mockedPost.mockRejectedValue(axiosError(429));
    const pub = new TelegramPublisher(makeConfig());
    await expect(pub.publish({ caption: 'oi' }, '-100555')).rejects.toThrow(
      'throttled:telegram',
    );
  });

  it('fails fast when token missing', async () => {
    const pub = new TelegramPublisher(makeConfig(''));
    await expect(pub.publish({ caption: 'oi' }, '-100555')).rejects.toThrow(
      'telegram_token_missing',
    );
    expect(mockedPost).not.toHaveBeenCalled();
  });
});
