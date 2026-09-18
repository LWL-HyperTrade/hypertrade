// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {BuilderPadGraduationMath} from "./libraries/BuilderPadGraduationMath.sol";

/**
 * @title BuilderPadGraduationGuard
 * @notice Stateless preflight for a graduation's Uniswap V4 seed. It keeps
 * the tick and liquidity math outside BuilderPadLaunchFactory's runtime bytecode
 * while modelling the rejections of the real mint, so a launch can never
 * drain its curve into a seed the PositionManager or V4 core would reject.
 *
 * The preflight has to mirror the whole downstream call graph rather than the
 * PositionManager's ABI field widths alone. Phase one is irreversible: it
 * marks the curve graduated and moves its reserves to the factory, so a seed
 * that passes here and reverts in V4 leaves the launch permanently unseedable
 * and recoverable only through the owner's delayed rescue path.
 */
contract BuilderPadGraduationGuard {
    int24 private constant MIN_USABLE_TICK = -887272;
    int24 private constant MAX_USABLE_TICK = 887272;

    /**
     * @dev V4 carries pool balance changes in a `BalanceDelta` whose halves are
     * `int128`, and `Pool.modifyLiquidity` narrows each side with
     * `SafeCast.toInt128`. The PositionManager's `MINT_POSITION` ABI accepts
     * `uint128`, so an amount in between passes every field-width check and
     * still reverts inside V4 core. The signed bound is the real one.
     */
    uint256 private constant MAX_SEED_AMOUNT = uint256(uint128(type(int128).max));

    error SqrtPriceOutOfBounds();
    error GraduationSeedNotViable();

    /**
     * @notice Verifies a launch can initialize and mint a nonzero, full-range
     * V4 position without lossy amount narrowing.
     * @param token Launch token being seeded.
     * @param pairToken Quote asset of the pool; the zero address for native ETH.
     * @param tickSpacing Pool tick spacing the position spans.
     * @param quoteAmount Quote-asset side of the seed.
     * @param tokenAmount Launch-token side of the seed.
     */
    function assertSeedable(
        address token,
        address pairToken,
        int24 tickSpacing,
        uint256 quoteAmount,
        uint256 tokenAmount
    ) external pure {
        if (token == address(0) || quoteAmount > MAX_SEED_AMOUNT || tokenAmount > MAX_SEED_AMOUNT) {
            revert GraduationSeedNotViable();
        }

        // Native ETH sorts below every ERC-20; two ERC-20s sort by address.
        // The seed price is orientation-dependent, so the ordering here must
        // match the PoolKey the factory will build.
        bool quoteIsCurrency0 = pairToken < token;
        (uint256 amount0, uint256 amount1) = quoteIsCurrency0 ? (quoteAmount, tokenAmount) : (tokenAmount, quoteAmount);
        _assertSeedable(tickSpacing, amount0, amount1);
    }

    /**
     * @notice Verifies a seed of these proportions mints under either currency
     * ordering.
     * @dev Launch terms are checked before the launch token exists, so the
     * ordering the PoolKey will use is not yet known. Requiring both is the
     * conservative reading, and the two agree in practice: the sqrt price
     * range is symmetric about 1 and the liquidity formula is invariant under
     * inverting the price and swapping the amounts with it.
     * @param tickSpacing Pool tick spacing the position spans.
     * @param quoteAmount Quote-asset side of the seed.
     * @param tokenAmount Launch-token side of the seed.
     */
    function assertSeedableEitherOrdering(int24 tickSpacing, uint256 quoteAmount, uint256 tokenAmount) external pure {
        if (quoteAmount > MAX_SEED_AMOUNT || tokenAmount > MAX_SEED_AMOUNT) {
            revert GraduationSeedNotViable();
        }
        _assertSeedable(tickSpacing, quoteAmount, tokenAmount);
        _assertSeedable(tickSpacing, tokenAmount, quoteAmount);
    }

    /**
     * @dev Models the price and liquidity rejections of the real mint for one
     * currency ordering. Amount bounds are the caller's to enforce.
     */
    function _assertSeedable(int24 tickSpacing, uint256 amount0, uint256 amount1) private pure {
        uint160 sqrtPriceX96 = BuilderPadGraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);
        if (sqrtPriceX96 <= TickMath.MIN_SQRT_PRICE || sqrtPriceX96 >= TickMath.MAX_SQRT_PRICE) {
            revert SqrtPriceOutOfBounds();
        }

        (int24 tickLower, int24 tickUpper) = _fullRangeTicks(tickSpacing);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );
        // This mint initializes both boundary ticks, so the position's own
        // liquidity is the entire `liquidityGross` at each of them. V4 reverts
        // with TickLiquidityOverflow once a tick's gross liquidity passes the
        // cap its spacing implies, which is an independent rejection from the
        // amount bounds above.
        if (liquidity == 0 || liquidity > Pool.tickSpacingToMaxLiquidityPerTick(tickSpacing)) {
            revert GraduationSeedNotViable();
        }
    }

    /**
     * @dev Derives V4's usable full-range ticks for the configured spacing.
     */
    function _fullRangeTicks(int24 tickSpacing) private pure returns (int24 tickLower, int24 tickUpper) {
        // Truncation toward zero is required to derive V4's usable boundary ticks.
        // forge-lint: disable-next-line(divide-before-multiply)
        tickLower = (MIN_USABLE_TICK / tickSpacing) * tickSpacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        tickUpper = (MAX_USABLE_TICK / tickSpacing) * tickSpacing;
    }
}
