// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BaseHook} from "@uniswap/v4-hooks-public/src/base/BaseHook.sol";

import {BuilderPadBuybackVault} from "../BuilderPadBuybackVault.sol";
import {FeePolicySnapshot, IBuilderPadFeeEscrow, IBuilderPadFeePolicy} from "../interfaces/ILaunchpadV2.sol";

/**
 * @title BuilderPadMemeHook
 * @notice Singleton Uniswap V4 hook shared by every graduated pons v2 pool.
 * Takes a fee cut on every swap via `afterSwap` (Flaunch-style Internal Swap
 * Pool), and whenever that cut lands in the memecoin, converts it back to
 * the pool's quote currency (ETH for the common native pairToken, or the
 * launch's chosen ERC-20 pairToken otherwise) against the pool's own
 * liquidity before it is ever distributed. The same protocol / creator /
 * buyback-and-burn split that governs BuilderPadBondingCurve's pre-graduation
 * fee sweep lives here, read live by the curve through IBuilderPadFeePolicy so
 * both phases behave identically.
 */
contract BuilderPadMemeHook is BaseHook, IUnlockCallback, IBuilderPadFeePolicy, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum SwapDirection {
        MemecoinToQuote,
        QuoteToMemecoin
    }

    struct LaunchInfo {
        bool registered;
        bool memecoinIsCurrency0;
        address memecoin;
        address quoteToken; // address(0) denotes native ETH
        address creator;
        // Buyback locks retain this recipient even when future immediate
        // creator payouts are transferred to a different address.
        address buybackCreatorRecipient;
        address protocolFeeRecipient;
        // Creator-chosen at launch on BuilderPadLaunchFactory, snapshotted here
        // at registerPool time. Charged the same way hookFeeBps is, but paid
        // entirely to the creator, bypassing the protocol/buyback split.
        uint16 creatorTaxBps;
        uint16 protocolFeeShareBps;
        uint16 buybackBurnBps;
        uint16 hookFeeBps;
        uint16 maxInternalPriceImpactBps;
        bool buybackEnabled;
    }

    uint256 private constant BASIS_POINTS = 10_000;
    uint256 private constant MAX_PROTOCOL_FEE_SHARE_BPS = 5_000;
    uint256 private constant MAX_HOOK_FEE_BPS = 1_000;
    // Mirrors BuilderPadBondingCurve's own ceiling, so a graduated pool can never
    // charge more per trade than the curve it graduated from.
    uint256 private constant MAX_TOTAL_TRADE_FEE_BPS = 2_000;

    error NotFactory();
    error AlreadySet();
    error OwnershipCannotBeRenounced();
    error ZeroAddress();
    error InvalidBps();
    error AlreadyRegistered();
    error UnknownPool();
    error InvalidPoolKey();
    error NotFeeSweepOperator();
    error InternalSwapRequiresOperator();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error MinimumOutputRequired();
    error InexactQuoteTransfer(address token, uint256 expected, uint256 received);
    error NothingToRescue();

    event FactorySet(address factory);
    event PoolRegistered(PoolId indexed poolId, address memecoin, address quoteToken, address creator);
    event CreatorFeeRecipientUpdated(
        PoolId indexed poolId, address indexed previousRecipient, address indexed newRecipient
    );
    // Reported separately because the two accrue to different ledgers: the
    // fee splits across protocol, buyback and creator on sweep, while the tax
    // is paid to the creator in full.
    event HookFeeCollected(PoolId indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount);
    event PoolFeesSwept(
        PoolId indexed poolId,
        uint256 protocolAmount,
        uint256 buybackAmount,
        uint256 creatorAmount,
        uint256 tokensLocked
    );
    event PoolFeesRescued(
        PoolId indexed poolId, address indexed quoteToken, uint256 protocolAmount, uint256 creatorAmount
    );
    event PoolBuybackSkipped(PoolId indexed poolId, uint256 foldedBackQuote);
    event PoolConversionSkipped(PoolId indexed poolId, uint256 retainedMemecoin);
    event BuybackVaultSet(address vault);
    event ProtocolFeeShareUpdated(uint256 bps);
    event BuybackBurnBpsUpdated(uint256 bps);
    event HookFeeBpsUpdated(uint256 bps);
    event MaxInternalPriceImpactUpdated(uint256 bps);
    event ProtocolFeeRecipientUpdated(address recipient);
    event FeeSweepOperatorUpdated(address operator);
    event BuybackEnabledUpdated(PoolId indexed poolId, bool enabled);

    IBuilderPadFeeEscrow public immutable feeEscrow;

    address public factory;
    BuilderPadBuybackVault public buybackVault;
    address public protocolFeeRecipient;
    uint256 public protocolFeeShareBps;
    uint256 public buybackBurnBps;
    uint256 public hookFeeBps;
    uint256 public maxInternalPriceImpactBps;
    address public feeSweepOperator;

    mapping(PoolId => LaunchInfo) public launches;
    mapping(PoolId => PoolKey) private _poolKeys;
    mapping(PoolId => mapping(address currency => uint256 amount)) public pendingFees;
    // Tracked separately from pendingFees so the creator tax never enters
    // the protocol/buyback split math; it is folded straight into the
    // creator's payout at sweep time.
    mapping(PoolId => mapping(address currency => uint256 amount)) public pendingCreatorTax;
    // The slice of pendingFees already earmarked for buyback-and-lock, set
    // aside as each swap's fee was charged under whatever the pool's buyback
    // flag said at that moment. Bucketing at accrual rather than deriving the
    // slice at sweep time keeps the flag forward-looking: toggling it decides
    // how the next swap's fee is split, never how an already-charged one is.
    // Held per currency and carried across the memecoin-to-quote conversion
    // in proportion to the fee it rode in on, so an earmark accrued in the
    // memecoin still reaches the vest.
    mapping(PoolId => mapping(address currency => uint256 amount)) public pendingBuyback;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /**
     * @param poolManager_ The canonical Uniswap V4 pool manager.
     * @param feeEscrow_ Shared claimable balance ledger, also used by every bonding curve.
     * @param protocolFeeRecipient_ Escrow key credited with the protocol's share.
     * @param initialOwner_ Protocol deployer; the only address that can ever change fee policy.
     */
    constructor(
        IPoolManager poolManager_,
        IBuilderPadFeeEscrow feeEscrow_,
        address protocolFeeRecipient_,
        address initialOwner_
    ) BaseHook(poolManager_) Ownable(initialOwner_) {
        if (address(poolManager_) == address(0) || address(feeEscrow_) == address(0)) {
            revert ZeroAddress();
        }
        if (protocolFeeRecipient_ == address(0)) revert ZeroAddress();

        feeEscrow = feeEscrow_;
        protocolFeeRecipient = protocolFeeRecipient_;
        protocolFeeShareBps = 3_000;
        buybackBurnBps = 5_000;
        hookFeeBps = 100;
        maxInternalPriceImpactBps = 300;
        feeSweepOperator = initialOwner_;
    }

    /**
     * @notice Only `afterSwap` is enabled: fee collection happens once per
     * swap, after the pool's own core swap math has already run.
     */
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------------
    // Owner-only configuration
    // ---------------------------------------------------------------------

    /**
     * @notice One-time wiring of the v2 factory, set after both are deployed
     * since the factory needs this hook's mined address to build pool keys.
     */
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert AlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /**
     * @notice One-time wiring of the shared five-year buyback vest, set
     * after both are deployed, so `_distribute` can lock the buyback leg
     * into it instead of burning it.
     */
    function setBuybackVault(BuilderPadBuybackVault buybackVault_) external onlyOwner {
        if (address(buybackVault) != address(0)) revert AlreadySet();
        if (address(buybackVault_) == address(0)) revert ZeroAddress();
        buybackVault = buybackVault_;
        emit BuybackVaultSet(address(buybackVault_));
    }

    /**
     * @notice Permanently disabled. An ownerless hook could never rotate the
     * fee sweep operator, so accrued fees on every graduated pool would stay
     * stranded. Ownership can still be transferred to a new owner.
     */
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    function setProtocolFeeShareBps(uint256 bps) external onlyOwner {
        if (bps > MAX_PROTOCOL_FEE_SHARE_BPS) revert InvalidBps();
        protocolFeeShareBps = bps;
        emit ProtocolFeeShareUpdated(bps);
    }

    function setBuybackBurnBps(uint256 bps) external onlyOwner {
        if (bps > BASIS_POINTS) revert InvalidBps();
        buybackBurnBps = bps;
        emit BuybackBurnBpsUpdated(bps);
    }

    function setHookFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_HOOK_FEE_BPS) revert InvalidBps();
        hookFeeBps = bps;
        emit HookFeeBpsUpdated(bps);
    }

    function setMaxInternalPriceImpactBps(uint256 bps) external onlyOwner {
        if (bps == 0 || bps >= BASIS_POINTS) revert InvalidBps();
        maxInternalPriceImpactBps = bps;
        emit MaxInternalPriceImpactUpdated(bps);
    }

    function setProtocolFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        protocolFeeRecipient = recipient;
        emit ProtocolFeeRecipientUpdated(recipient);
    }

    /**
     * @notice Sets the trusted operator that executes fee conversions with
     * explicit minimum outputs, preventing arbitrary callers from triggering
     * predictable swaps against a manipulated spot price.
     */
    function setFeeSweepOperator(address operator) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        feeSweepOperator = operator;
        emit FeeSweepOperatorUpdated(operator);
    }

    /**
     * @notice Returns the policy terms new launches snapshot immutably.
     */
    function currentFeePolicy() external view override returns (FeePolicySnapshot memory) {
        return _currentFeePolicy();
    }

    function _currentFeePolicy() private view returns (FeePolicySnapshot memory) {
        return FeePolicySnapshot({
            protocolFeeRecipient: protocolFeeRecipient,
            protocolFeeShareBps: uint16(protocolFeeShareBps),
            buybackBurnBps: uint16(buybackBurnBps),
            hookFeeBps: uint16(hookFeeBps),
            maxInternalPriceImpactBps: uint16(maxInternalPriceImpactBps)
        });
    }

    // ---------------------------------------------------------------------
    // Factory wiring
    // ---------------------------------------------------------------------

    /**
     * @notice Registers a pool with fee terms frozen at launch by the factory.
     * @dev `buybackCreatorRecipient` is the creator recipient the curve was
     * constructed with, passed so the vest this pool tops up lands in the
     * same vault epoch as any tranche the curve locked pre-graduation.
     *
     * It is not immutable in effect. The vault only reads it to seed an empty
     * slot, and the factory forwards every later creator-fee-recipient
     * rotation into `updateCreatorRecipient`, so the live beneficiary follows
     * the creator fee stream. That is deliberate: it is what lets a
     * compromised creator key be recovered without orphaning the vest.
     */
    function registerPool(
        PoolKey calldata key,
        address memecoin,
        address creator,
        address buybackCreatorRecipient,
        uint16 creatorTaxBps,
        bool buybackEnabled,
        FeePolicySnapshot calldata policy
    ) external onlyFactory {
        _registerPool(key, memecoin, creator, buybackCreatorRecipient, creatorTaxBps, buybackEnabled, policy);
    }

    function _registerPool(
        PoolKey calldata key,
        address memecoin,
        address creator,
        address buybackCreatorRecipient,
        uint16 creatorTaxBps,
        bool buybackEnabled,
        FeePolicySnapshot memory policy
    ) private {
        PoolId poolId = key.toId();
        if (launches[poolId].registered) revert AlreadyRegistered();
        if (creator == address(0) || buybackCreatorRecipient == address(0)) revert ZeroAddress();
        // Terms frozen here govern the pool for life, so each is held to the
        // same ceiling as the setter that produced it. protocolFeeShareBps
        // against BASIS_POINTS rather than MAX_PROTOCOL_FEE_SHARE_BPS would
        // let a pool be registered on terms the live policy could never
        // reach, paying the creator nothing.
        if (
            policy.protocolFeeRecipient == address(0) || policy.protocolFeeShareBps > MAX_PROTOCOL_FEE_SHARE_BPS
                || policy.buybackBurnBps > BASIS_POINTS || policy.hookFeeBps > MAX_HOOK_FEE_BPS
                || policy.maxInternalPriceImpactBps == 0 || policy.maxInternalPriceImpactBps >= BASIS_POINTS
        ) {
            revert InvalidBps();
        }
        // The curve bounds the same sum in its own constructor rather than
        // inheriting it from the factory. A pool taking more than the whole
        // unspecified leg would flip the swapper's output delta negative.
        if (uint256(creatorTaxBps) + policy.hookFeeBps > MAX_TOTAL_TRADE_FEE_BPS) revert InvalidBps();

        // The factory builds the key correctly today, but these two facts are
        // what every later fee credit and swap direction is derived from. A
        // memecoin that is neither currency would silently designate the wrong
        // side as quote and route fees to a slot nothing ever reads.
        if (address(key.hooks) != address(this)) revert InvalidPoolKey();
        bool memecoinIsCurrency0 = Currency.unwrap(key.currency0) == memecoin;
        if (!memecoinIsCurrency0 && Currency.unwrap(key.currency1) != memecoin) revert InvalidPoolKey();

        address quoteToken = memecoinIsCurrency0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);

        launches[poolId] = LaunchInfo({
            registered: true,
            memecoinIsCurrency0: memecoinIsCurrency0,
            memecoin: memecoin,
            quoteToken: quoteToken,
            creator: creator,
            buybackCreatorRecipient: buybackCreatorRecipient,
            protocolFeeRecipient: policy.protocolFeeRecipient,
            creatorTaxBps: creatorTaxBps,
            protocolFeeShareBps: policy.protocolFeeShareBps,
            buybackBurnBps: policy.buybackBurnBps,
            hookFeeBps: policy.hookFeeBps,
            maxInternalPriceImpactBps: policy.maxInternalPriceImpactBps,
            buybackEnabled: buybackEnabled
        });
        _poolKeys[poolId] = key;

        emit PoolRegistered(poolId, memecoin, quoteToken, creator);
    }

    /**
     * @notice Updates who receives this pool's creator fee share. Restricted
     * to the factory, which gates both self-service creator transfers and
     * protocol-owner overrides before forwarding here, so this contract only
     * needs to trust one caller.
     */
    function setCreatorFeeRecipient(PoolId poolId, address newRecipient) external onlyFactory {
        LaunchInfo storage info = launches[poolId];
        if (!info.registered) revert UnknownPool();
        if (newRecipient == address(0)) revert ZeroAddress();

        emit CreatorFeeRecipientUpdated(poolId, info.creator, newRecipient);
        info.creator = newRecipient;
    }

    /**
     * @notice Updates whether a registered launch routes its configured fee
     * share through buyback-and-lock.
     * @dev Applies to fees charged from here on, not to fees already pending.
     * Each swap earmarks its buyback slice as it is charged, so a toggle
     * cannot reach back and reroute value that accrued under the opposite
     * setting. Without that, a disable landing before a sweep would divert a
     * buyback the creator had already earned into their own payout, and an
     * enable would sweep fees earned under a plain split into the vest.
     */
    function setBuybackEnabled(PoolId poolId, bool enabled) external onlyFactory {
        LaunchInfo storage info = launches[poolId];
        if (!info.registered) revert UnknownPool();
        info.buybackEnabled = enabled;
        emit BuybackEnabledUpdated(poolId, enabled);
    }

    // ---------------------------------------------------------------------
    // IHooks: only beforeInitialize and afterSwap are enabled. BaseHook
    // supplies the externally reachable callbacks, each already restricted to
    // the pool manager, and reverts HookNotImplemented for every permission
    // getHookPermissions() leaves off.
    // ---------------------------------------------------------------------

    /**
     * @dev Registration is what binds a pool id to its memecoin, quote asset,
     * and fee recipients, and every later fee credit is derived from that
     * record. Restricting initialization to the factory keeps a pool bearing
     * this hook from existing without one.
     */
    function _beforeInitialize(address sender, PoolKey calldata, uint160) internal view override returns (bytes4) {
        if (sender != factory) revert NotFactory();
        return IHooks.beforeInitialize.selector;
    }

    /**
     * @notice Takes `hookFeeBps` plus this pool's `creatorTaxBps` of the
     * swap's unspecified currency straight out of the pool manager's
     * flash-accounting ledger in a single `take`, crediting the two cuts to
     * separate pending balances so the creator tax never mixes with the
     * protocol/buyback-and-lock split. If either cut lands in the
     * memecoin, it is left untouched here and only converted to the quote
     * currency later, in a batched `sweepPoolFees` call, rather than on
     * every single swap.
     */
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        // The conversion and buyback legs swap against this same pool, but
        // they are never taxed here: v4-core skips a pool's hooks when the
        // hook itself is the caller (Hooks.afterSwap). Were that not so, the
        // skim would come out of the buyback before it reached the vault.
        PoolId poolId = key.toId();
        LaunchInfo memory info = launches[poolId];
        if (!info.registered) return (IHooks.afterSwap.selector, 0);
        if (info.hookFeeBps == 0 && info.creatorTaxBps == 0) return (IHooks.afterSwap.selector, 0);

        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        (Currency feeCurrency, int128 unspecifiedAmount) =
            specifiedIsCurrency0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (unspecifiedAmount < 0) unspecifiedAmount = -unspecifiedAmount;
        if (unspecifiedAmount == 0) return (IHooks.afterSwap.selector, 0);

        uint256 unspecified = uint256(uint128(unspecifiedAmount));
        uint256 feeAmount = (unspecified * info.hookFeeBps) / BASIS_POINTS;
        uint256 taxAmount = (unspecified * info.creatorTaxBps) / BASIS_POINTS;
        uint256 totalAmount = feeAmount + taxAmount;
        if (totalAmount == 0) return (IHooks.afterSwap.selector, 0);

        address feeCurrencyAddr = Currency.unwrap(feeCurrency);
        _takeExact(feeCurrency, feeCurrencyAddr, totalAmount);
        if (feeAmount != 0) {
            pendingFees[poolId][feeCurrencyAddr] += feeAmount;
            if (info.buybackEnabled) {
                // The buyback comes out of the creator's bucket alone, so it
                // is measured against what remains after the protocol's share.
                uint256 creatorSlice = feeAmount - (feeAmount * info.protocolFeeShareBps) / BASIS_POINTS;
                pendingBuyback[poolId][feeCurrencyAddr] += (creatorSlice * info.buybackBurnBps) / BASIS_POINTS;
            }
        }
        if (taxAmount != 0) pendingCreatorTax[poolId][feeCurrencyAddr] += taxAmount;

        emit HookFeeCollected(poolId, feeCurrencyAddr, feeAmount, taxAmount);
        return (IHooks.afterSwap.selector, int128(uint128(totalAmount)));
    }

    // ---------------------------------------------------------------------
    // Fee sweep: ISP conversion, buyback-and-lock, and distribution
    // ---------------------------------------------------------------------

    /**
     * @notice Converts any pending memecoin-denominated fee into the pool's
     * quote currency against the pool's own liquidity, then splits the
     * combined quote-currency total into protocol / buyback-and-lock /
     * creator using the live policy, exactly mirroring the bonding curve's
     * own sweep. The trusted sweep operator is required whenever the sweep
     * would execute an internal conversion or buyback. The creator may still
     * distribute already-quoted fees when no internal swap is needed.
     */
    function sweepPoolFees(PoolId poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)
        external
        nonReentrant
    {
        LaunchInfo memory info = launches[poolId];
        if (!info.registered) revert UnknownPool();
        bool isOperator = msg.sender == feeSweepOperator;
        if (!isOperator && msg.sender != info.creator) revert NotFeeSweepOperator();
        if (!isOperator && _requiresTrustedOperator(poolId, info)) revert InternalSwapRequiresOperator();

        (uint256 convertedFeeQuote, uint256 convertedTaxQuote, uint256 convertedBuybackQuote, bool converted) =
            _convertPendingMemecoin(poolId, info, minConversionQuoteOut);
        // Only a conversion that actually executed is subject to the caller's
        // minimum. Enforcing it when there was nothing to convert, or when the
        // swap filled nothing and the pending amount was restored for a later
        // retry, would block the quote-denominated legs of the sweep over a
        // conversion that never happened.
        uint256 conversionQuoteOut = convertedFeeQuote + convertedTaxQuote;
        if (converted && conversionQuoteOut < minConversionQuoteOut) {
            revert SlippageExceeded(conversionQuoteOut, minConversionQuoteOut);
        }

        uint256 totalQuote = pendingFees[poolId][info.quoteToken] + convertedFeeQuote;
        uint256 taxQuote = pendingCreatorTax[poolId][info.quoteToken] + convertedTaxQuote;
        uint256 buybackQuote = pendingBuyback[poolId][info.quoteToken] + convertedBuybackQuote;
        if (totalQuote == 0 && taxQuote == 0) return;
        pendingFees[poolId][info.quoteToken] = 0;
        pendingCreatorTax[poolId][info.quoteToken] = 0;
        pendingBuyback[poolId][info.quoteToken] = 0;

        _distribute(poolId, info, totalQuote, taxQuote, buybackQuote, minBuybackTokensOut);
    }

    /**
     * @notice Owner-only escape hatch for a pool's pending quote-token fees
     * when they can no longer reach the protocol and creator through the
     * normal exact-delivery path, for example an approved pair token that
     * later turns out to be fee-on-transfer, rebasing, or otherwise unable
     * to move its exact nominal amount. `sweepPoolFees` would revert
     * indefinitely in that case, since `_payOut` enforces exact delivery
     * into the fee escrow and there is no way to satisfy it. This bypasses
     * the escrow and the buyback conversion entirely (the buyback swap
     * would fail for the same underlying reason) and pays the protocol and
     * creator their regular split with a direct transfer instead, so the
     * quote-token balance the hook already holds is never permanently
     * stuck. A native quote leg is skipped rather than rejected: ETH cannot
     * fail an exact-delivery transfer, so it has nothing to rescue.
     *
     * The pool's memecoin-denominated fees are rescued regardless of what the
     * quote currency is, because their only ordinary exit is the conversion
     * swap. Gating the whole function on an ERC-20 quote would leave a native
     * pool's memecoin fees with no recovery at all, and would also strand its
     * ETH fees behind them, since sweepPoolFees converts before it
     * distributes and reverts as a unit.
     */
    function rescuePoolFees(PoolId poolId)
        external
        onlyOwner
        nonReentrant
        returns (uint256 protocolAmount, uint256 creatorAmount)
    {
        LaunchInfo memory info = launches[poolId];
        if (!info.registered) revert UnknownPool();
        address quoteToken = info.quoteToken;

        if (quoteToken != address(0)) {
            (protocolAmount, creatorAmount) = _rescueCurrency(poolId, info, quoteToken);
        }
        (uint256 memecoinProtocol, uint256 memecoinCreator) = _rescueCurrency(poolId, info, info.memecoin);
        if (protocolAmount == 0 && creatorAmount == 0 && memecoinProtocol == 0 && memecoinCreator == 0) {
            revert NothingToRescue();
        }
    }

    /**
     * @dev Zeroes one currency's pending buckets for a pool and pays the
     * protocol and creator their regular split directly, bypassing the
     * escrow. Returns zero for both legs when there is nothing pending, so
     * the caller can tell whether any currency had a balance to rescue.
     */
    function _rescueCurrency(PoolId poolId, LaunchInfo memory info, address currency)
        private
        returns (uint256 protocolAmount, uint256 creatorAmount)
    {
        uint256 total = pendingFees[poolId][currency];
        uint256 tax = pendingCreatorTax[poolId][currency];
        if (total == 0 && tax == 0) return (0, 0);

        pendingFees[poolId][currency] = 0;
        pendingCreatorTax[poolId][currency] = 0;
        // The rescue pays the creator their whole bucket rather than running
        // a buyback, since the swap would fail for the same reason the escrow
        // path did. Clearing the earmark keeps it from surviving as a claim
        // on fees this call has already paid out.
        pendingBuyback[poolId][currency] = 0;

        protocolAmount = (total * info.protocolFeeShareBps) / BASIS_POINTS;
        creatorAmount = total - protocolAmount + tax;

        if (protocolAmount != 0) IERC20(currency).safeTransfer(info.protocolFeeRecipient, protocolAmount);
        if (creatorAmount != 0) IERC20(currency).safeTransfer(info.creator, creatorAmount);

        emit PoolFeesRescued(poolId, currency, protocolAmount, creatorAmount);
    }

    /**
     * @dev Limits price-sensitive pool interactions to the protocol's sweep
     * operator. A creator can distribute direct quote balances when buyback is
     * disabled, but cannot select a permissive minimum around a manipulable
     * spot price for inventory shared with the protocol.
     */
    function _requiresTrustedOperator(PoolId poolId, LaunchInfo memory info) private view returns (bool) {
        if (pendingFees[poolId][info.memecoin] != 0 || pendingCreatorTax[poolId][info.memecoin] != 0) {
            return true;
        }

        return pendingBuyback[poolId][info.quoteToken] != 0;
    }

    /**
     * @dev Converts fee and creator-tax memecoin inventory in one swap so the
     * sweep receives one aggregate price boundary. Partial input and output
     * are allocated proportionally back to their separate accounting buckets.
     * The buyback earmark rides along inside the fee bucket, converting in
     * the same proportion so a partial fill leaves the unconverted remainder
     * carrying the share of the earmark it still owes.
     */
    function _convertPendingMemecoin(PoolId poolId, LaunchInfo memory info, uint256 minConversionQuoteOut)
        private
        returns (uint256 feeQuoteOut, uint256 taxQuoteOut, uint256 buybackQuoteOut, bool converted)
    {
        uint256 feePending = pendingFees[poolId][info.memecoin];
        uint256 taxPending = pendingCreatorTax[poolId][info.memecoin];
        uint256 buybackPending = pendingBuyback[poolId][info.memecoin];
        uint256 totalPending = feePending + taxPending;
        if (totalPending == 0) return (0, 0, 0, false);
        if (minConversionQuoteOut == 0) revert MinimumOutputRequired();

        pendingFees[poolId][info.memecoin] = 0;
        pendingCreatorTax[poolId][info.memecoin] = 0;
        pendingBuyback[poolId][info.memecoin] = 0;
        (uint256 consumed, uint256 quoteOut) = _executeInternalSwap(poolId, SwapDirection.MemecoinToQuote, totalPending);
        if (consumed == 0) {
            pendingFees[poolId][info.memecoin] += feePending;
            pendingCreatorTax[poolId][info.memecoin] += taxPending;
            pendingBuyback[poolId][info.memecoin] += buybackPending;
            emit PoolConversionSkipped(poolId, totalPending);
            return (0, 0, 0, false);
        }
        converted = true;

        uint256 feeConsumed = FullMath.mulDiv(consumed, feePending, totalPending);
        uint256 taxConsumed = consumed - feeConsumed;
        feeQuoteOut = FullMath.mulDiv(quoteOut, feeConsumed, consumed);
        taxQuoteOut = quoteOut - feeQuoteOut;

        // The earmark is a marker on part of the fee bucket, so it converts
        // at the fee bucket's own fill ratio and then at the rate that bucket
        // actually realised. feePending is non-zero whenever the earmark is,
        // since the earmark was accrued as a fraction of it.
        if (buybackPending != 0) {
            uint256 buybackConsumed = FullMath.mulDiv(buybackPending, feeConsumed, feePending);
            buybackQuoteOut = feeConsumed == 0 ? 0 : FullMath.mulDiv(feeQuoteOut, buybackConsumed, feeConsumed);
            pendingBuyback[poolId][info.memecoin] += buybackPending - buybackConsumed;
        }

        pendingFees[poolId][info.memecoin] += feePending - feeConsumed;
        pendingCreatorTax[poolId][info.memecoin] += taxPending - taxConsumed;
    }

    /**
     * @dev Splits `totalQuote` into protocol / buyback-and-lock / creator,
     * running the buyback leg as a real swap of the quote currency back
     * into the memecoin before locking the result into the shared
     * five-year vest instead of burning it. `taxQuote` bypasses the split
     * entirely and is added straight to the creator's payout.
     * @param buybackQuote The slice of `totalQuote` earmarked for buyback as
     * its fees were charged. Passed in rather than derived here so a toggle
     * of the pool's buyback flag cannot reroute value that already accrued.
     */
    function _distribute(
        PoolId poolId,
        LaunchInfo memory info,
        uint256 totalQuote,
        uint256 taxQuote,
        uint256 buybackQuote,
        uint256 minBuybackTokensOut
    ) private {
        uint256 protocolAmount = (totalQuote * info.protocolFeeShareBps) / BASIS_POINTS;
        uint256 creatorBucket = totalQuote - protocolAmount;
        // The earmark was summed per swap, so its rounding can land a wei or
        // two above the bucket recomputed here on the aggregate. Clamping
        // keeps the subtraction below sound at a full buyback share, where
        // the two would otherwise be equal.
        uint256 requestedBuyback = buybackQuote < creatorBucket ? buybackQuote : creatorBucket;
        uint256 creatorAmount = creatorBucket - requestedBuyback + taxQuote;

        uint256 buybackSpent;
        uint256 tokensLocked;
        if (requestedBuyback != 0) {
            if (minBuybackTokensOut == 0) revert MinimumOutputRequired();
            (buybackSpent, tokensLocked) = _executeInternalSwap(poolId, SwapDirection.QuoteToMemecoin, requestedBuyback);
            // Return the unfilled quote amount to the creator bucket. The
            // price limit bounds execution without silently retaining value
            // that has already been removed from the creator's accounting.
            creatorAmount += requestedBuyback - buybackSpent;
            if (tokensLocked != 0) {
                IERC20(info.memecoin).forceApprove(address(buybackVault), tokensLocked);
                buybackVault.lock(
                    info.memecoin,
                    tokensLocked,
                    info.buybackCreatorRecipient,
                    info.protocolFeeRecipient,
                    info.protocolFeeShareBps
                );
                if (tokensLocked < minBuybackTokensOut) {
                    revert SlippageExceeded(tokensLocked, minBuybackTokensOut);
                }
            } else if (buybackSpent == 0) {
                // Same rule the curve applies: only a buyback that actually
                // executes is subject to the caller's minimum. Enforcing it on
                // a buyback that filled nothing would block the creator and
                // protocol legs too, stranding the whole distribution over a
                // leg that has already been folded back above.
                emit PoolBuybackSkipped(poolId, requestedBuyback);
            } else {
                // Input was consumed but rounded to no output at all. That
                // quote is gone into the pool with nothing locked against it,
                // so it can be neither folded back nor treated as a skip.
                revert SlippageExceeded(0, minBuybackTokensOut);
            }
        }

        _payOut(info.creator, info.quoteToken, creatorAmount);
        _payOut(info.protocolFeeRecipient, info.quoteToken, protocolAmount);

        emit PoolFeesSwept(poolId, protocolAmount, buybackSpent, creatorAmount, tokensLocked);
    }

    function _payOut(address recipient, address quoteToken, uint256 amount) private {
        if (amount == 0) return;
        if (quoteToken == address(0)) {
            feeEscrow.credit{value: amount}(recipient);
        } else {
            uint256 balanceBefore = IERC20(quoteToken).balanceOf(address(feeEscrow));
            IERC20(quoteToken).forceApprove(address(feeEscrow), amount);
            feeEscrow.creditToken(recipient, quoteToken, amount);
            uint256 received = IERC20(quoteToken).balanceOf(address(feeEscrow)) - balanceBefore;
            if (received != amount) revert InexactQuoteTransfer(quoteToken, amount, received);
        }
    }

    /**
     * @dev Opens a standalone unlock context to run one exact-input internal
     * swap, bounded by a price-impact ceiling measured against the pool's
     * live price.
     *
     * That ceiling limits how far this swap moves the price, not where the
     * price started. A front-run that depresses spot first shifts the whole
     * band down with it, so the bound is slippage control rather than
     * manipulation resistance. What actually caps the loss on a sandwich is
     * the caller's `minConversionQuoteOut` / `minBuybackTokensOut`, which is
     * why every price-sensitive sweep is gated to the sweep operator by
     * `_requiresTrustedOperator`. Treat those minimums as the real defense
     * and size them off an independent price.
     */
    function _executeInternalSwap(PoolId poolId, SwapDirection direction, uint256 amountIn)
        private
        returns (uint256 amountInConsumed, uint256 amountOut)
    {
        bytes memory result = poolManager.unlock(abi.encode(poolId, direction, amountIn));
        (amountInConsumed, amountOut) = abi.decode(result, (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolId poolId, SwapDirection direction, uint256 amountIn) = abi.decode(data, (PoolId, SwapDirection, uint256));

        LaunchInfo memory info = launches[poolId];
        PoolKey memory key = _poolKeys[poolId];
        bool zeroForOne =
            direction == SwapDirection.MemecoinToQuote ? info.memecoinIsCurrency0 : !info.memecoinIsCurrency0;

        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(poolManager, poolId);
        uint160 sqrtPriceLimitX96 = _priceLimit(sqrtPriceX96, zeroForOne, info.maxInternalPriceImpactBps);

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -SafeCast.toInt256(amountIn),
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            ""
        );

        _settleCurrency(key.currency0, delta.amount0());
        _settleCurrency(key.currency1, delta.amount1());

        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        uint256 amountInConsumed = inputDelta < 0 ? SafeCast.toUint256(-int256(inputDelta)) : 0;
        uint256 amountOut = outputDelta > 0 ? SafeCast.toUint256(int256(outputDelta)) : 0;
        return abi.encode(amountInConsumed, amountOut);
    }

    function _settleCurrency(Currency currency, int128 amount) private {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (currency.isAddressZero()) {
                // PoolManager.sync carries no unlock modifier, so the synced-
                // currency slot is transient state anyone can leave set for
                // the rest of a transaction. Settling native against a stale
                // non-zero slot takes the ERC-20 branch and reverts
                // NonzeroNativeValue, which v4-core calls out as a DoS vector.
                poolManager.sync(currency);
                poolManager.settle{value: owed}();
            } else {
                address token = Currency.unwrap(currency);
                uint256 balanceBefore = IERC20(token).balanceOf(address(poolManager));
                poolManager.sync(currency);
                IERC20(token).safeTransfer(address(poolManager), owed);
                uint256 received = IERC20(token).balanceOf(address(poolManager)) - balanceBefore;
                if (received != owed) revert InexactQuoteTransfer(token, owed, received);
                poolManager.settle();
            }
        } else if (amount > 0) {
            _takeExact(currency, Currency.unwrap(currency), uint256(uint128(amount)));
        }
    }

    /**
     * @dev Records only assets that reached the hook in full. Uniswap V4's
     * flash accounting requires exact ERC-20 transfers, so transfer-tax quote
     * assets fail atomically instead of creating an underfunded fee balance.
     *
     * On an exact-output swap the fee is charged on the swapper's input leg,
     * which the PoolManager has not been paid yet, so this take draws from
     * the shared pot and reverts if the fee alone exceeds the PoolManager's
     * whole balance of that currency. Reaching that needs an input on the
     * order of fifty times the PoolManager's holdings, and the revert falls
     * on the swap that caused it. No other pool can lose value to it either,
     * since v4's unlock invariant makes the swapper settle the enlarged debt
     * before the transaction ends.
     */
    function _takeExact(Currency currency, address token, uint256 amount) private {
        if (currency.isAddressZero()) {
            poolManager.take(currency, address(this), amount);
            return;
        }

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        poolManager.take(currency, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert InexactQuoteTransfer(token, amount, received);
    }

    /**
     * @dev Bounds the pool's sqrt-price movement for batched internal swaps.
     * For a constant-product pool this matches the bonding curve's
     * `amountIn / (reserve + amountIn)` reserve-movement bound. The resulting
     * spot-price percentage is larger because spot price is proportional to
     * sqrtPriceX96 squared; `maxInternalPriceImpactBps` is retained as the
     * public policy name for compatibility across both phases.
     */
    function _priceLimit(uint160 sqrtPriceX96, bool zeroForOne, uint256 maxPriceImpactBps)
        private
        pure
        returns (uint160)
    {
        uint256 factor = BASIS_POINTS - maxPriceImpactBps;
        if (zeroForOne) {
            uint256 limit = (uint256(sqrtPriceX96) * factor) / BASIS_POINTS;
            // forge-lint: disable-next-line(unsafe-typecast)
            return limit <= TickMath.MIN_SQRT_PRICE ? TickMath.MIN_SQRT_PRICE + 1 : uint160(limit);
        } else {
            uint256 limit = (uint256(sqrtPriceX96) * BASIS_POINTS) / factor;
            // casting to uint160 is safe because this branch only runs when limit < TickMath.MAX_SQRT_PRICE, which is itself < type(uint160).max
            // forge-lint: disable-next-line(unsafe-typecast)
            return limit >= TickMath.MAX_SQRT_PRICE ? TickMath.MAX_SQRT_PRICE - 1 : uint160(limit);
        }
    }

    /**
     * @notice Accepts native ETH pulled out of the pool manager via `take`.
     */
    receive() external payable {}
}
