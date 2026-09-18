// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBuilderPadFeeEscrow, IBuilderPadLaunchFactory, GraduationPhase} from "../../src/interfaces/ILaunchpadV2.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @notice Burns `feeBps` of every transfer — models a non-standard quote asset.
contract FeeOnTransferERC20 is MockERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) MockERC20("FoT", "FOT", 18) {
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @notice Minimal factory stand-in: owner maps token -> curve.
contract MockFactory {
    mapping(address token => address curve) public curveOf;

    function setCurve(address token, address curve) external {
        curveOf[token] = curve;
    }

    function getLaunchedToken(address token) external view returns (IBuilderPadLaunchFactory.LaunchedToken memory l) {
        l.token = token;
        l.curve = curveOf[token];
        l.exists = l.curve != address(0);
        l.phase = GraduationPhase.NotGraduated;
    }
}

/// @notice Stand-in for a bonding curve: reports its token and forwards credits.
contract MockCurve {
    address public token;
    IBuilderPadFeeEscrow public escrow;

    constructor(address token_, IBuilderPadFeeEscrow escrow_) {
        token = token_;
        escrow = escrow_;
    }

    function setToken(address t) external {
        token = t;
    }

    function creditNative(address recipient) external payable {
        escrow.credit{value: msg.value}(recipient);
    }

    function creditToken(address recipient, address erc20, uint256 amount) external {
        IERC20(erc20).approve(address(escrow), amount);
        escrow.creditToken(recipient, erc20, amount);
    }

    receive() external payable {}
}

/// @notice Any contract that can forward credits (used as hook / vault stand-in).
contract MockCrediter {
    IBuilderPadFeeEscrow public escrow;

    constructor(IBuilderPadFeeEscrow escrow_) {
        escrow = escrow_;
    }

    function creditNative(address recipient) external payable {
        escrow.credit{value: msg.value}(recipient);
    }

    function creditToken(address recipient, address erc20, uint256 amount) external {
        IERC20(erc20).approve(address(escrow), amount);
        escrow.creditToken(recipient, erc20, amount);
    }
}

/// @notice A "curve" that lies: reports a token whose factory record points elsewhere.
contract LyingCurve {
    address public token;
    IBuilderPadFeeEscrow public escrow;

    constructor(address token_, IBuilderPadFeeEscrow escrow_) {
        token = token_;
        escrow = escrow_;
    }

    function creditNative(address recipient) external payable {
        escrow.credit{value: msg.value}(recipient);
    }
}

/// @notice Contract whose `token()` reverts.
contract RevertingTokenGetter {
    IBuilderPadFeeEscrow public escrow;

    constructor(IBuilderPadFeeEscrow escrow_) {
        escrow = escrow_;
    }

    function token() external pure returns (address) {
        revert("nope");
    }

    function creditNative(address recipient) external payable {
        escrow.credit{value: msg.value}(recipient);
    }
}

/// @notice Recipient that re-enters `claim()` on receive.
contract ReentrantClaimer {
    IBuilderPadFeeEscrow public escrow;
    uint256 public reentries;
    bool public reenterSucceeded;

    constructor(IBuilderPadFeeEscrow escrow_) {
        escrow = escrow_;
    }

    function claimAll() external returns (uint256) {
        return escrow.claim();
    }

    function claimAmount(uint256 a) external returns (uint256) {
        return escrow.claim(a);
    }

    receive() external payable {
        if (reentries == 0) {
            reentries++;
            // Must fail (nonReentrant) — record if it ever succeeds.
            try escrow.claim() returns (uint256) {
                reenterSucceeded = true;
            } catch {}
        }
    }
}

/// @notice Recipient that rejects ETH.
contract RejectingRecipient {
    IBuilderPadFeeEscrow public escrow;

    constructor(IBuilderPadFeeEscrow escrow_) {
        escrow = escrow_;
    }

    function claimAll() external returns (uint256) {
        return escrow.claim();
    }

    receive() external payable {
        revert("no eth");
    }
}
