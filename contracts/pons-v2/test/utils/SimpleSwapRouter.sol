// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/**
 * @notice Test-only Uniswap v4 swap router: unlock → swap → settle/take.
 * Just enough to drive a graduated pool through the hook in fork tests.
 */
contract SimpleSwapRouter is IUnlockCallback {
    IPoolManager public immutable manager;

    struct Data {
        address payer;
        PoolKey key;
        SwapParams params;
    }

    constructor(IPoolManager m) {
        manager = m;
    }

    /// @dev Exact-in swap. For ERC-20 input the payer must have approved this router.
    function swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn) external payable returns (BalanceDelta) {
        SwapParams memory p = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        bytes memory out = manager.unlock(abi.encode(Data({payer: msg.sender, key: key, params: p})));
        return abi.decode(out, (BalanceDelta));
    }

    function unlockCallback(bytes calldata raw) external override returns (bytes memory) {
        require(msg.sender == address(manager), "router: not manager");
        Data memory d = abi.decode(raw, (Data));
        BalanceDelta delta = manager.swap(d.key, d.params, "");
        _settle(d.key.currency0, delta.amount0(), d.payer);
        _settle(d.key.currency1, delta.amount1(), d.payer);
        return abi.encode(delta);
    }

    function _settle(Currency c, int128 amt, address payer) internal {
        if (amt < 0) {
            uint256 owed = uint256(uint128(-amt));
            if (c.isAddressZero()) {
                manager.settle{value: owed}();
            } else {
                manager.sync(c);
                IERC20(Currency.unwrap(c)).transferFrom(payer, address(manager), owed);
                manager.settle();
            }
        } else if (amt > 0) {
            manager.take(c, payer, uint256(uint128(amt)));
        }
    }

    receive() external payable {}
}
