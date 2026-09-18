// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title BuilderPadBondingCurveMath
 * @notice Constant-product bonding curve math shared by BuilderPadBondingCurve, adapted
 * from the BootstrapPool.sol reference (code-423n4/2025-01-iq-ai). Reserves and fee
 * are passed explicitly so the same formula prices trades in either direction and can
 * also price the curve's internal buyback swap.
 */
library BuilderPadBondingCurveMath {
    uint256 internal constant BASIS_POINTS = 10_000;

    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();

    /**
     * @notice Quotes the output amount for an exact input amount, net of the trade fee.
     * @param amountIn Exact amount of the input asset being sold into the curve.
     * @param reserveIn Curve reserve of the input asset before this trade.
     * @param reserveOut Curve reserve of the output asset before this trade.
     * @param feeBps Fee charged on the input amount, in basis points.
     */
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        amountOut = _amountOut(amountIn, reserveIn, reserveOut, feeBps);
        if (amountOut == 0) revert InsufficientOutputAmount();
    }

    /**
     * @notice Same quote as `getAmountOut`, returning zero where that reverts.
     * @dev For callers that treat an unpriceable trade as a condition to
     * handle rather than an error, such as the curve's internal buyback,
     * which folds the slice back into the creator's payout when the curve is
     * too thin to execute against. Routing that case through the reverting
     * variant would take the whole fee sweep down with it, stranding fees
     * exactly when the curve cannot support a buyback.
     */
    function quoteAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0 || feeBps >= BASIS_POINTS) return 0;
        return _amountOut(amountIn, reserveIn, reserveOut, feeBps);
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        private
        pure
        returns (uint256)
    {
        uint256 amountInWithFee = amountIn * (BASIS_POINTS - feeBps);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * BASIS_POINTS + amountInWithFee;
        return numerator / denominator;
    }

    /**
     * @notice Quotes the input amount required for an exact output amount, net of the trade fee.
     * @param amountOut Exact amount of the output asset requested from the curve.
     * @param reserveIn Curve reserve of the input asset before this trade.
     * @param reserveOut Curve reserve of the output asset before this trade.
     * @param feeBps Fee charged on the input amount, in basis points.
     */
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256 amountIn)
    {
        if (amountOut == 0) revert InsufficientOutputAmount();
        if (reserveIn == 0 || reserveOut <= amountOut) revert InsufficientLiquidity();
        // A full-fee trade has no input that produces output, and the
        // denominator below would divide by zero rather than say so.
        if (feeBps >= BASIS_POINTS) revert InsufficientLiquidity();

        uint256 numerator = amountOut * reserveIn * BASIS_POINTS;
        uint256 denominator = (reserveOut - amountOut) * (BASIS_POINTS - feeBps);
        amountIn = numerator / denominator + 1;
    }
}
