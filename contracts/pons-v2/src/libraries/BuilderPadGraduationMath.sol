// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/**
 * @title BuilderPadGraduationMath
 * @notice Derives the sqrtPriceX96 needed to seed a brand-new Uniswap V4 pool
 * with a single full-range position from two known token amounts. In the
 * full-range limit (tickLower/tickUpper at the usable min/max ticks), a
 * position's amount0 and amount1 approach `liquidity / sqrtPrice` and
 * `liquidity * sqrtPrice`, so `amount1 / amount0` converges to the pool
 * price. This is exact enough for seeding a graduation pool, since both
 * amounts here are the bonding curve's real, non-extreme final reserves.
 */
library BuilderPadGraduationMath {
    error ZeroAmount();
    error UnsupportedPrice();

    /**
     * @notice Computes sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96.
     * @param amount0 Amount of the pool's currency0, must be nonzero.
     * @param amount1 Amount of the pool's currency1, must be nonzero.
     */
    function sqrtPriceX96FromAmounts(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();

        if (_fitsQ192(amount0, amount1)) {
            uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
            // forge-lint: disable-next-line(unsafe-typecast)
            return uint160(Math.sqrt(ratioX192));
        }

        // A Q128 ratio preserves the remaining valid V4 price range without
        // requiring the intermediate Q192 quotient to fit in uint256.
        if (!_fitsQ128(amount0, amount1)) revert UnsupportedPrice();
        uint256 ratioX128 = FullMath.mulDiv(amount1, 1 << 128, amount0);
        uint256 sqrtPriceX64 = Math.sqrt(ratioX128);
        if (sqrtPriceX64 > type(uint128).max) revert UnsupportedPrice();

        // sqrt(amount1 / amount0 * 2^128) is Q64. Shift it into Q96.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(sqrtPriceX64 << 32);
    }

    /**
     * @dev A Q192 quotient fits uint256 only when amount1 / amount0 is
     * strictly below 2^64. Avoiding the multiplication also avoids overflow.
     */
    function _fitsQ192(uint256 amount0, uint256 amount1) private pure returns (bool) {
        if (amount0 > type(uint192).max) return true;
        return amount1 < (amount0 << 64);
    }

    /**
     * @dev A Q128 quotient covers V4's remaining representable price range.
     */
    function _fitsQ128(uint256 amount0, uint256 amount1) private pure returns (bool) {
        if (amount0 > type(uint128).max) return true;
        return amount1 < (amount0 << 128);
    }
}
