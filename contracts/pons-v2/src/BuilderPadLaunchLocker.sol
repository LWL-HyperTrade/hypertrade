// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721ReceiverLike} from "./interfaces/ILaunchpadV2.sol";

/**
 * @title BuilderPadLaunchLocker
 * @notice Permanently holds the graduated Uniswap V4 position NFT for every
 * pons v2 launch. Unlike v1's locker, there is no `collectFees()` here: fee
 * collection and distribution belong entirely to BuilderPadMemeHook and
 * BuilderPadFeeEscrow, since a V4 position accrues fees inside the singleton
 * PoolManager rather than on the NFT itself. This contract exposes no
 * withdrawal or arbitrary-call function, so locked liquidity can never be
 * removed by an administrator.
 */
contract BuilderPadLaunchLocker is Ownable2Step, IERC721ReceiverLike {
    using SafeERC20 for IERC20;

    error NotFactory();
    error AlreadyInitialized();
    error ZeroAddress();
    error PositionAlreadyLocked();
    error PositionNotHeld();
    error NotPositionManager();
    error OwnershipCannotBeRenounced();

    event FactorySet(address factory);
    event PositionLocked(address indexed token, uint256 indexed tokenId);
    event TokenSupplyLocked(address indexed token, uint256 amount);

    address public immutable positionManager;
    address public factory;

    mapping(address token => uint256 tokenId) public lockedPositions;
    mapping(address token => uint256 amount) public lockedTokenSupply;
    mapping(address token => bool locked) private _locked;

    /**
     * @param initialOwner Administrative owner; only used to wire the factory once.
     * @param positionManager_ The canonical Uniswap V4 PositionManager for this chain.
     */
    constructor(address initialOwner, address positionManager_) Ownable(initialOwner) {
        if (positionManager_ == address(0)) revert ZeroAddress();
        positionManager = positionManager_;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /**
     * @notice One-time wiring of the v2 factory, set after both are deployed.
     */
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert AlreadyInitialized();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /**
     * @notice Permanently disabled. Ownership here exists only to perform the
     * one-time factory wiring, and renouncing before that wiring would leave
     * the locker unable to ever accept a graduated position.
     */
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    /**
     * @notice Rejects safe transfers of anything but a canonical position NFT.
     * @dev Not part of the graduation path. Graduation names this locker as
     * the `MINT_POSITION` owner, and the PositionManager mints with a plain
     * `_mint`, which fires no receiver callback. Custody is established by
     * the `ownerOf` check in `lockPosition` instead. This exists so the
     * locker still behaves correctly under an explicit `safeTransferFrom`,
     * and so such a transfer can only ever originate from the canonical
     * PositionManager.
     */
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != positionManager) revert NotPositionManager();
        return IERC721ReceiverLike.onERC721Received.selector;
    }

    /**
     * @notice Registers and verifies permanent custody of a graduated position.
     * @dev Called once per launch by the factory, immediately after minting
     * the full-range position directly to this locker's address.
     */
    function lockPosition(address token, uint256 tokenId) external onlyFactory {
        if (_locked[token]) revert PositionAlreadyLocked();
        if (IERC721(positionManager).ownerOf(tokenId) != address(this)) revert PositionNotHeld();

        _locked[token] = true;
        lockedPositions[token] = tokenId;
        emit PositionLocked(token, tokenId);
    }

    /**
     * @notice Permanently locks the virtual-reserve token remainder that
     * cannot enter the graduated pool without lowering its opening price.
     */
    function lockTokenSupply(address token, uint256 amount) external onlyFactory {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        lockedTokenSupply[token] += amount;
        emit TokenSupplyLocked(token, amount);
    }

    /**
     * @notice Returns whether a launch's position has been locked here.
     */
    function isLocked(address token) external view returns (bool) {
        return _locked[token];
    }
}
