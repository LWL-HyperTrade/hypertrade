/**
 * PONS v2 ONLY.
 * Canonical docs: https://docs.ponsfamily.com/v2
 * Do NOT follow https://docs.ponsfamily.com/ — that is v1 (Uniswap v3
 * factory / locker / `tokenProtocolFeeShares`). These signatures are v2:
 * Launching a token, Buying and selling, Getting a quote, Reading state,
 * Claiming fees, Events, Uniswap v4 pools.
 *
 * `canLaunch(address)` and `maxCreatorTaxBps()` are named in v2 prose
 * without ABI strings — types from LaunchFactory (`uint16 public`).
 */
import { parseAbi } from 'viem';

export const FACTORY_ABI = parseAbi([
  // Launching a token → Enumerating launch configs
  'struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }',
  'function launchConfigCount() view returns (uint256)',
  'function getLaunchConfig(uint256 id) view returns (LaunchConfig)',
  // Launching a token → Launching with a pinned quote
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)',
  // Overload: extra wallets exempt from the launch-window snipe tax (max 32). Launcher + fee recipient are exempt automatically.
  'function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)',
  'function snipeTaxStartBps() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function launchFee() view returns (uint256)',
  // Launching a token → prose: canLaunch(address), maxCreatorTaxBps()
  'function canLaunch(address account) view returns (bool)',
  'function maxCreatorTaxBps() view returns (uint16)',
  // Launching a token → Choosing a quote asset
  'function approvedPairTokens(address pairToken) view returns (bool)',
  'function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)',
  // Reading state → Reading the launch record
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  // Creator controls → Whether to buy back. Owner may only disable.
  'function setBuybackEnabled(address token, bool enabled)',
  'event BuybackEnabledUpdated(address indexed token, bool enabled, address indexed controller)',
  // Events to index
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]);

/** Launching a token → Launching and buying atomically. */
export const LAUNCH_AND_BUY_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)',
]);

/** Getting a quote + Claiming fees → "Fees reach the escrow only after a sweep". */
export const CURVE_ABI = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function sellableTokens() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  // Buying and selling
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
]);

/** Claiming fees → Claiming across assets. */
export const ESCROW_ABI = parseAbi([
  'function balanceOf(address recipient) view returns (uint256)',
  'function balanceOfToken(address recipient, address token) view returns (uint256)',
  'function claim()',
  'function claimToken(address token)',
]);

/**
 * v2 → Claiming fees + Uniswap v4 pools (not v1 locker / V3 position).
 * Post-graduation unswept position is on the meme hook until a sweep.
 */
export const HOOK_ABI = parseAbi([
  // Fee policy snapshotted per launch (IPonsV2FeePolicy). Owner-mutable → read live for previews.
  'function hookFeeBps() view returns (uint256)',
  'function protocolFeeShareBps() view returns (uint256)',
  'function buybackBurnBps() view returns (uint256)',
  'function pendingFees(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)',
]);

/** Standard ERC-20 surface for custom-pair launches (approve the router first). */
export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
]);

/** Custom errors from docs → Errors, mapped to user copy. */
export const PONS_ERROR_COPY: Record<string, string> = {
  SlippageExceeded: 'Price moved before the buy settled. Try again.',
  CurveGraduated: 'This launch already graduated to its pool.',
  LaunchEconomicsMismatch: 'Pons changed launch terms while you were reading them. Re-read and retry.',
  PairTokenNotApproved: 'That quote asset is not approved by Pons.',
  PairTokenDecimalsMismatch: 'Quote asset decimals changed on-chain. Pick another quote.',
  NativeValueMismatch: 'ETH sent did not match the buy amount.',
  UnexpectedNativeValue: 'ETH was sent to a custom-pair launch.',
  LaunchFeeNotPaid: 'Launch fee did not match launchFee(). Re-read and retry.',
  CreatorTaxTooHigh: 'Creator tax is above the Pons cap.',
  NotWhitelisted: 'Pons launches are whitelist-only right now. Your app is live; launch the token later from My apps.',
  LaunchConfigDisabled: 'That launch config was disabled by Pons. Reload and retry.',
  ExemptionListTooLong: 'Too many snipe-tax exemptions.',
  InvalidTokenParams: 'Token name or symbol is empty. Fix the terms and retry.',
  MetadataTooLong: 'Token name, logo URL, description, or a social link is too long for Pons.',
  NotCreatorFeeRecipient: 'This wallet is not the token fee recipient. Sign from that wallet and retry.',
  NotBuybackController: 'Only the fee recipient can change buybacks.',
  TokenNotFound: 'Pons has no launch record for this token.',
};
