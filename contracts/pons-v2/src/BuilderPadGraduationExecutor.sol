// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {BuilderPadLaunchLocker} from "./BuilderPadLaunchLocker.sol";

/**
 * @title BuilderPadGraduationExecutor
 * @notice Performs the two heaviest steps of pons v2 graduation on
 * BuilderPadLaunchFactory's behalf: swapping swept ETH for a non-native
 * pairToken, and minting the full-range Uniswap V4 position. Split out into
 * its own contract purely so BuilderPadLaunchFactory's own bytecode stays under
 * EIP-170's 24576-byte deployed-code limit: the swap-router branching,
 * Permit2 approval dance, PositionManager action encoding, and post-mint
 * dust sweep account for a large share of that size on their own. The
 * factory transfers exactly the assets a mint needs here immediately before
 * calling in, so this contract never holds a balance between transactions.
 */
contract BuilderPadGraduationExecutor {
    using SafeERC20 for IERC20;

    uint256 private constant MINT_DEADLINE_WINDOW = 300;

    error NotFactory();
    error ZeroAddress();
    error FeeTransferFailed();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error MintAmountOverflow();

    event GraduationDustSwept(address indexed launchToken, address indexed currency, uint256 amount);
    event GraduationDustRetained(address indexed launchToken, address indexed currency, uint256 amount);

    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    BuilderPadLaunchLocker public immutable locker;
    address public immutable factory;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(
        IPositionManager positionManager_,
        IAllowanceTransfer permit2_,
        BuilderPadLaunchLocker locker_,
        address factory_
    ) {
        if (address(positionManager_) == address(0) || address(permit2_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(locker_) == address(0) || factory_ == address(0)) revert ZeroAddress();
        positionManager = positionManager_;
        permit2 = permit2_;
        locker = locker_;
        factory = factory_;
    }

    /**
     * @notice Mints a full-range position directly to the locker from
     * balances the factory just transferred here, then forwards any
     * post-mint rounding dust on either leg to `protocolFeeRecipient`.
     * @dev Full-range liquidity is derived here from the pool's starting
     * price and the target amounts, rather than by the factory, because the
     * tick and liquidity math inlines a large amount of code that the
     * factory has no room for. The exact amounts SETTLE_PAIR ends up pulling
     * almost always round down slightly against those targets, so the
     * post-mint sweep prevents dust piling up here.
     */
    function mintFullRangePosition(
        address launchToken,
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint160 sqrtPriceX96,
        uint256 amount0Max,
        uint256 amount1Max,
        Currency currency0,
        Currency currency1,
        address protocolFeeRecipient
    ) external payable onlyFactory {
        // MINT_POSITION takes both maxima as uint128, so a larger amount would
        // truncate and settle a position that does not match the reserves the
        // curve was drained of. The factory's preflight already rejects these,
        // but silent truncation is not a property worth delegating to a
        // caller.
        if (amount0Max > type(uint128).max || amount1Max > type(uint128).max) revert MintAmountOverflow();

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0Max,
            amount1Max
        );

        bool hasNative = currency0.isAddressZero();
        if (!hasNative) _approvePermit2(Currency.unwrap(currency0), amount0Max);
        _approvePermit2(Currency.unwrap(currency1), amount1Max);

        bytes memory actions = hasNative
            ? abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP))
            : abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](hasNative ? 3 : 2);
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128(amount0Max),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128(amount1Max),
            address(locker),
            bytes("")
        );
        params[1] = abi.encode(currency0, currency1);
        if (hasNative) params[2] = abi.encode(currency0, address(this));

        positionManager.modifyLiquidities{value: msg.value}(
            abi.encode(actions, params), block.timestamp + MINT_DEADLINE_WINDOW
        );

        _sweepResidualBalance(launchToken, currency0, protocolFeeRecipient);
        _sweepResidualBalance(launchToken, currency1, protocolFeeRecipient);
    }

    /**
     * @dev Grants Permit2 a standard ERC-20 approval, then records a
     * matching Permit2 allowance for the PositionManager, the two-step
     * approval Permit2-based transfers always require from the token owner.
     */
    function _approvePermit2(address token, uint256 amount) private {
        IERC20(token).forceApprove(address(permit2), amount);
        // Amount is a real token balance the factory just transferred here, always far below uint160's range.
        // forge-lint: disable-next-line(unsafe-typecast)
        permit2.approve(
            token, address(positionManager), uint160(amount), uint48(block.timestamp + MINT_DEADLINE_WINDOW)
        );
    }

    /**
     * @dev Sends any leftover balance of `currency` held by this contract to
     * the protocol treasury, or to the locker when the currency is the launch
     * token itself. Covers both native dust returned by the position
     * manager's own SWEEP action and ERC-20 dust that was simply never pulled
     * out via Permit2 in the first place.
     *
     * Routing the launch-token leg to the locker keeps the guarantee that
     * supply which did not reach the pool never enters circulation. Paying it
     * to the treasury instead would make that guarantee approximate, and
     * would attribute one launch's retained dust to whichever launch
     * graduates next, since this sweeps the whole balance rather than a
     * per-graduation delta.
     *
     * A failed sweep is reported rather than thrown. Disposing of rounding
     * dust is incidental to seeding the pool, and letting it revert would
     * leave a launch that has already surrendered its reserves unable to ever
     * complete. Whatever cannot be sent stays here and is carried out by the
     * next graduation that sweeps the same currency.
     */
    function _sweepResidualBalance(address launchToken, Currency currency, address recipient) private {
        uint256 amount = currency.isAddressZero()
            ? address(this).balance
            : IERC20(Currency.unwrap(currency)).balanceOf(address(this));
        if (amount == 0) return;

        if (Currency.unwrap(currency) == launchToken) recipient = address(locker);

        bool swept;
        if (currency.isAddressZero()) {
            (swept,) = payable(recipient).call{value: amount}("");
        } else {
            // A low-level call rather than try/catch around IERC20.transfer.
            // `catch` covers a revert inside the callee, but not a failure to
            // decode what it returned, and that decode happens in this frame
            // and propagates. A token that transfers successfully while
            // returning no data would therefore revert the whole graduation,
            // which is precisely the token class the non-throwing design here
            // exists to tolerate.
            (bool ok, bytes memory ret) =
                Currency.unwrap(currency).call(abi.encodeCall(IERC20.transfer, (recipient, amount)));
            swept = ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
        }

        if (swept) {
            emit GraduationDustSwept(launchToken, Currency.unwrap(currency), amount);
        } else {
            emit GraduationDustRetained(launchToken, Currency.unwrap(currency), amount);
        }
    }

    /**
     * @notice Accepts native ETH the factory forwards for a mint and any
     * dust the PositionManager's own SWEEP action returns here.
     */
    receive() external payable {}
}
