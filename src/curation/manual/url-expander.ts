export const SHORT_URL_EXPANDER = Symbol('SHORT_URL_EXPANDER');

export interface ShortUrlExpander {
  /** Follow redirects and return the final URL. Never throws — on any
   *  failure returns the input unchanged so the caller degrades cleanly. */
  expand(url: string): Promise<string>;
}

/** Short-link hosts we expand before extracting a product id. */
export function isShortMeliUrl(url: string): boolean {
  return /(^|\/\/)([a-z0-9.-]*\.)?meli\.la\//i.test(url);
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpShortUrlExpander implements ShortUrlExpander {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  async expand(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // `fetch` follows redirects by default; res.url is the final URL.
      const res = await this.fetchFn(url, {
        redirect: 'follow',
        signal: controller.signal,
      });
      return res.url && res.url.length > 0 ? res.url : url;
    } catch {
      return url;
    } finally {
      clearTimeout(timer);
    }
  }
}
