import { config } from '../config.js';

/**
 * CoinGlass bars include dollar taker buy/sell. CoinAnk's buy/sell series is a
 * ratio, so it is dropped for every coin — crypto and HIP-3 — and spot taker
 * is not fetched. That gap is permanent. Prompts must not treat it as a
 * missing bar, a balanced tape, or a reason to stay flat.
 * A CoinGlass bar that happens to lack flow still uses the missing-flow rules.
 */
export function takerFlowInFeed(): boolean {
  return !config.coinankMode;
}
