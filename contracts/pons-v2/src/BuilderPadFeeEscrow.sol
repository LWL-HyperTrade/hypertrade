// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBuilderPadFeeEscrow, IBuilderPadLaunchFactory} from "./interfaces/ILaunchpadV2.sol";

/**
 * @notice Narrow surface the escrow needs from a caller that claims to be a
 * launch's bonding curve: the launch token it prices. The address is then
 * checked against the factory's launch record, so an unrelated contract
 * returning an arbitrary token can never pass.
 */
interface IBuilderPadCurveLike {
    function token() external view returns (address);
}

/**
 * @title BuilderPadFeeEscrow
 * @notice Minimal pull-payment ledger for protocol and creator fees in native
 * ETH and ERC-20 quote assets. Fees are *credited* here by the protocol's own
 * contracts and *claimed* by recipients on their own schedule, so a recipient
 * that cannot receive a transfer can never block a sweep for everyone else.
 *
 * Implements `IBuilderPadFeeEscrow` exactly as the bonding curve, meme hook and
 * buyback vault expect:
 * - `credit(recipient)`         payable, credits `msg.value` of ETH
 * - `creditToken(r, token, amt)` pulls `amt` of `token` from the caller via
 *                                `transferFrom` and credits what was received
 * - `claim()` / `claim(amount)` / `claimToken(token)` / `claimToken(token, amount)`
 *
 * Authorization mirrors BuilderPadBuybackVault: the shared meme hook and the
 * buyback vault are authorized directly; a bonding curve is authorized by
 * looking its address up live from the factory's launch record for the token
 * it reports, so no per-launch admin action is ever needed.
 *
 * Deliberately absent: arbitrary calls, swaps, upgradeability, admin
 * withdrawals, and any push payment during sweeps.
 */
contract BuilderPadFeeEscrow is IBuilderPadFeeEscrow, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error AlreadyInitialized();
    error NotAuthorizedCrediter();
    error InsufficientBalance();
    error NativeTransferFailed();
    error OwnershipCannotBeRenounced();

    event FactorySet(address factory);
    event HookSet(address hook);
    event BuybackVaultSet(address vault);
    event Credited(address indexed recipient, uint256 amount);
    event CreditedToken(address indexed recipient, address indexed token, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);
    event ClaimedToken(address indexed recipient, address indexed token, uint256 amount);

    /// @notice Factory whose launch records authorize each launch's curve.
    address public factory;
    /// @notice Shared meme hook (post-graduation fee source).
    address public hook;
    /// @notice Buyback vault (vested release source).
    address public buybackVault;

    mapping(address recipient => uint256 amount) private _native;
    mapping(address recipient => mapping(address token => uint256 amount)) private _tokens;

    /// @notice Sum of all native balances owed. `address(this).balance >= totalNative` always.
    uint256 public totalNative;
    /// @notice Sum of all balances owed per token. `token.balanceOf(this) >= totalToken[token]` always.
    mapping(address token => uint256 amount) public totalToken;

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ------------------------------------------------------------------ //
    // One-time wiring (set after the dependants are deployed)
    // ------------------------------------------------------------------ //

    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert AlreadyInitialized();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setHook(address hook_) external onlyOwner {
        if (hook != address(0)) revert AlreadyInitialized();
        if (hook_ == address(0)) revert ZeroAddress();
        hook = hook_;
        emit HookSet(hook_);
    }

    function setBuybackVault(address vault_) external onlyOwner {
        if (buybackVault != address(0)) revert AlreadyInitialized();
        if (vault_ == address(0)) revert ZeroAddress();
        buybackVault = vault_;
        emit BuybackVaultSet(vault_);
    }

    /// @dev The escrow must always have an owner able to complete wiring.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }

    // ------------------------------------------------------------------ //
    // Crediting — protocol contracts only
    // ------------------------------------------------------------------ //

    /// @inheritdoc IBuilderPadFeeEscrow
    function credit(address recipient) external payable override {
        if (!_isAuthorizedCrediter(msg.sender)) revert NotAuthorizedCrediter();
        if (recipient == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        _native[recipient] += msg.value;
        totalNative += msg.value;
        emit Credited(recipient, msg.value);
    }

    /// @inheritdoc IBuilderPadFeeEscrow
    function creditToken(address recipient, address token, uint256 amount) external override nonReentrant {
        if (!_isAuthorizedCrediter(msg.sender)) revert NotAuthorizedCrediter();
        if (recipient == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        // Credit what actually arrived so the ledger can never exceed holdings,
        // even for a non-standard token. Callers that need exactness (the hook)
        // verify the delta on their side.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        _tokens[recipient][token] += received;
        totalToken[token] += received;
        emit CreditedToken(recipient, token, received);
    }

    // ------------------------------------------------------------------ //
    // Claims — recipient-triggered
    // ------------------------------------------------------------------ //

    /// @inheritdoc IBuilderPadFeeEscrow
    function claim() external override nonReentrant returns (uint256 amount) {
        amount = _native[msg.sender];
        _claimNative(amount);
    }

    /// @inheritdoc IBuilderPadFeeEscrow
    function claim(uint256 amount) external override nonReentrant returns (uint256) {
        _claimNative(amount);
        return amount;
    }

    /// @inheritdoc IBuilderPadFeeEscrow
    function claimToken(address token) external override nonReentrant returns (uint256 amount) {
        amount = _tokens[msg.sender][token];
        _claimToken(token, amount);
    }

    /// @inheritdoc IBuilderPadFeeEscrow
    function claimToken(address token, uint256 amount) external override nonReentrant returns (uint256) {
        _claimToken(token, amount);
        return amount;
    }

    // ------------------------------------------------------------------ //
    // Views
    // ------------------------------------------------------------------ //

    /// @inheritdoc IBuilderPadFeeEscrow
    function balanceOf(address recipient) external view override returns (uint256) {
        return _native[recipient];
    }

    /// @inheritdoc IBuilderPadFeeEscrow
    function balanceOfToken(address recipient, address token) external view override returns (uint256) {
        return _tokens[recipient][token];
    }

    /// @notice True if `caller` may credit balances right now.
    function isAuthorizedCrediter(address caller) external view returns (bool) {
        return _isAuthorizedCrediter(caller);
    }

    // ------------------------------------------------------------------ //
    // Internals
    // ------------------------------------------------------------------ //

    function _claimNative(uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 owed = _native[msg.sender];
        if (amount > owed) revert InsufficientBalance();
        _native[msg.sender] = owed - amount;
        totalNative -= amount;
        emit Claimed(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    function _claimToken(address token, uint256 amount) private {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 owed = _tokens[msg.sender][token];
        if (amount > owed) revert InsufficientBalance();
        _tokens[msg.sender][token] = owed - amount;
        totalToken[token] -= amount;
        emit ClaimedToken(msg.sender, token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /**
     * @dev Same shape as BuilderPadBuybackVault._isAuthorizedLocker: the singleton
     * hook and vault are trusted directly; a curve proves itself by reporting
     * its launch token, which the factory's record must map back to the
     * caller. An EOA or unrelated contract fails the lookup (or the call).
     */
    function _isAuthorizedCrediter(address caller) private view returns (bool) {
        if (caller == hook && hook != address(0)) return true;
        if (caller == buybackVault && buybackVault != address(0)) return true;
        if (factory == address(0) || caller.code.length == 0) return false;
        try IBuilderPadCurveLike(caller).token() returns (address token) {
            if (token == address(0)) return false;
            return caller == IBuilderPadLaunchFactory(factory).getLaunchedToken(token).curve;
        } catch {
            return false;
        }
    }
}
