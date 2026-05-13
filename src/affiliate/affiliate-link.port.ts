export const AFFILIATE_LINK_PORT = 'AffiliateLinkPort';

export interface AffiliateLinkPort {
  /**
   * Resolves a Mercado Livre product URL to an affiliate short link.
   * Falls back to original URL with UTM tag if no cached short link exists.
   */
  resolve(originalUrl: string): Promise<string>;

  /** Force re-read of underlying cache (e.g. after editing the JSON file). */
  reload(): Promise<void>;
}
