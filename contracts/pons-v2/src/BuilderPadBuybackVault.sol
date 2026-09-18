// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBuilderPadFeeEscrow, IBuilderPadFeePolicy, IBuilderPadLaunchFactory} from "./interfaces/ILaunchpadV2.sol";

/**
 * @title BuilderPadBuybackVault
 * @notice Holds every launch's bought-back memecoin supply and releases it
 * linearly over five years instead of burning it immediately, splitting
 * every release between the creator and the protocol on the launch's
 * recorded fee shares. One shared deployment serves every launch, the same
 * "single deployment for every token" pattern BuilderPadFeeEscrow already uses.
 *
 * Note that the split applies to the release, not to the funding. Both the
 * curve and the hook carve the buyback slice out of the creator's share of
 * the fees alone, so the creator funds the entire lock and then receives
 * only their fee share of it back. Enabling a buyback therefore moves value
 * from the creator to the protocol relative to taking the fees directly,
 * by an amount that grows with `buybackBurnBps`.
 *
 * Deposits use a weighted-average vesting clock instead of per-deposit
 * tranches: a launch's fee sweep can add to its lock on every single sweep,
 * and tracking an unbounded array of tranches would make `release()`'s gas
 * cost grow forever. Instead, each new deposit shifts the launch's single
 * `vestingStart` forward by an amount proportional to the deposit's share
 * of the new total, so a large existing lock is barely disturbed by a small
 * top-up, and a small existing lock is pulled close to the new deposit's own
 * clock. `vestedAmount` at any time reflects a fair, size-weighted blend
 * across every deposit made so far.
 */
contract BuilderPadBuybackVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct LaunchVest {
        uint256 totalLocked;
        uint256 totalReleased;
        uint256 vestingStart;
        uint256 vestedUnreleased;
        uint256 unvestedAmount;
        uint256 lastUpdate;
        uint256 vestingEnd;
        address creatorRecipient;
        address protocolRecipient;
        uint16 protocolFeeShareBps;
    }

    uint256 private constant BASIS_POINTS = 10_000;
    uint256 public constant VESTING_DURATION = 5 * 365 days;

    error ZeroAddress();
    error AlreadyInitialized();
    error NotFactory();
    error NotAuthorizedLocker();
    error NotVestBeneficiary();
    error InvalidVestingTerms();
    error VestingTermsMismatch();
    error OwnershipCannotBeRenounced();

    event FactorySet(address factory);
    event Locked(address indexed token, address indexed depositor, uint256 amount, uint256 newVestingStart);
    event VestingTermsSnapshotted(
        address indexed token,
        address indexed creatorRecipient,
        address indexed protocolRecipient,
        uint256 protocolFeeShareBps
    );
    event Released(address indexed token, uint256 creatorAmount, uint256 protocolAmount);
    event CreatorRecipientUpdated(
        address indexed token, address indexed previousRecipient, address indexed newRecipient
    );

    IBuilderPadFeePolicy public immutable feePolicy;
    IBuilderPadFeeEscrow public immutable feeEscrow;
    address public factory;

    mapping(address token => LaunchVest) private _vaults;

    /**
     * @param initialOwner Administrative owner; only used to wire the factory once.
     * @param feePolicy_ Shared protocol/creator split policy, the same singleton the curve and hook read.
     * @param feeEscrow_ Shared claimable balance ledger releases are paid through.
     */
    constructor(address initialOwner, IBuilderPadFeePolicy feePolicy_, IBuilderPadFeeEscrow feeEscrow_) Ownable(initialOwner) {
        if (address(feePolicy_) == address(0) || address(feeEscrow_) == address(0)) revert ZeroAddress();
        feePolicy = feePolicy_;
        feeEscrow = feeEscrow_;
    }

    /**
     * @notice One-time wiring of the v2 factory, set after both are
     * deployed, used to authorize each launch's bonding curve as a locker.
     */
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert AlreadyInitialized();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /**
     * @notice Permanently disabled. Ownership here exists only to perform the
     * one-time factory wiring, and renouncing before that wiring would strand
     * every future buyback lock.
     */
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    /**
     * @notice Locks `amount` of `token` into its five-year vest, preserving
     * the supplied beneficiaries and split for the active vesting epoch.
     * Restricted to the two legitimate callers for `token`'s own buyback:
     * the shared meme hook, or `token`'s own bonding curve looked up live
     * from the factory.
     */
    function lock(
        address token,
        uint256 amount,
        address creatorRecipient,
        address protocolRecipient,
        uint16 protocolFeeShareBps
    ) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (factory == address(0)) revert NotFactory();
        if (!_isAuthorizedLocker(token, msg.sender)) revert NotAuthorizedLocker();
        if (amount == 0) return;
        if (creatorRecipient == address(0) || protocolRecipient == address(0) || protocolFeeShareBps > BASIS_POINTS) {
            revert InvalidVestingTerms();
        }

        // Schedule against what arrived, not what was asked for. Recording a
        // nominal amount the vault never received would make the final
        // release of the epoch revert on its own balance, stranding the tail
        // of the vest. Every other ERC-20 boundary in the protocol measures
        // this delta; this one is no different for being fed by our own
        // launcher token today.
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        amount = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (amount == 0) return;

        LaunchVest storage v = _vaults[token];
        uint256 nowTs = block.timestamp;
        _checkpoint(v, nowTs);
        _setOrValidateVestingTerms(v, token, creatorRecipient, protocolRecipient, protocolFeeShareBps);

        uint256 existingUnvested = v.unvestedAmount;
        uint256 combinedAmount = existingUnvested + amount;
        uint256 remainingDuration = existingUnvested == 0 ? 0 : v.vestingEnd - nowTs;
        uint256 combinedDuration = (existingUnvested * remainingDuration + amount * VESTING_DURATION) / combinedAmount;

        v.unvestedAmount = combinedAmount;
        v.lastUpdate = nowTs;
        v.vestingEnd = nowTs + combinedDuration;
        v.vestingStart = nowTs - (VESTING_DURATION - combinedDuration);
        v.totalLocked += amount;

        emit Locked(token, msg.sender, amount, v.vestingStart);
    }

    /**
     * @notice Releases every currently vested, not-yet-released token for
     * `token`, using the beneficiaries and split frozen for its active
     * vesting epoch.
     * @dev Restricted to the two parties a release pays. Letting anyone
     * choose when value leaves the vest is harmful in two ways. A caller can
     * time a release inside the protocol owner's creator-recipient recovery
     * window, flushing vested tokens to the very address the recovery exists
     * to abandon. A caller can also advance the checkpoint every second, so
     * each step rounds its newly vested amount down to zero and the vest
     * stalls without ever paying out.
     */
    function release(address token) external nonReentrant returns (uint256 released) {
        if (factory == address(0)) revert NotFactory();

        LaunchVest storage v = _vaults[token];
        if (msg.sender != v.creatorRecipient && msg.sender != v.protocolRecipient) revert NotVestBeneficiary();

        _checkpoint(v, block.timestamp);
        released = v.vestedUnreleased;
        if (released == 0) return 0;
        v.vestedUnreleased = 0;
        v.totalReleased += released;

        uint256 protocolAmount = (released * v.protocolFeeShareBps) / BASIS_POINTS;
        uint256 creatorAmount = released - protocolAmount;

        IERC20(token).forceApprove(address(feeEscrow), released);
        if (protocolAmount != 0) feeEscrow.creditToken(v.protocolRecipient, token, protocolAmount);
        if (creatorAmount != 0) feeEscrow.creditToken(v.creatorRecipient, token, creatorAmount);

        emit Released(token, creatorAmount, protocolAmount);
    }

    /**
     * @notice Redirects a launch's buyback vest to a new creator recipient.
     * Restricted to the factory, which forwards both self-service creator
     * transfers and protocol-owner recovery overrides here, so vested
     * buyback tokens track the same recipient as immediate creator fees
     * rather than remaining stranded on the launch-time address. Vested but
     * not-yet-released tokens follow the new recipient too, matching the
     * intent of wallet recovery. Only the protocol split terms stay bound to
     * the launch snapshot; the creator identity is managed here instead.
     */
    function updateCreatorRecipient(address token, address newRecipient) external {
        if (msg.sender != factory) revert NotFactory();
        if (token == address(0) || newRecipient == address(0)) revert ZeroAddress();

        LaunchVest storage v = _vaults[token];
        address previousRecipient = v.creatorRecipient;
        if (previousRecipient == newRecipient) return;
        v.creatorRecipient = newRecipient;
        emit CreatorRecipientUpdated(token, previousRecipient, newRecipient);
    }

    /**
     * @notice Total amount of `token` ever locked into this vault.
     */
    function totalLocked(address token) external view returns (uint256) {
        return _vaults[token].totalLocked;
    }

    /**
     * @notice Total amount of `token` already released from this vault.
     */
    function totalReleased(address token) external view returns (uint256) {
        return _vaults[token].totalReleased;
    }

    /**
     * @notice The launch's current weighted-average vesting start time.
     * @dev Reporting only. Vesting is accounted from `vestedUnreleased`,
     * `unvestedAmount`, `lastUpdate` and `vestingEnd`, which are settled on
     * every lock and release. Interpolating this value against
     * `VESTING_DURATION` will not reproduce `vestedAmount`, because already
     * vested tokens are banked at each deposit rather than recomputed from
     * the shifted clock. Read `vestedAmount` for the authoritative figure.
     */
    function vestingStart(address token) external view returns (uint256) {
        return _vaults[token].vestingStart;
    }

    /**
     * @notice Amount of `token` vested so far, released or not.
     */
    function vestedAmount(address token) external view returns (uint256) {
        return _vestedAmount(_vaults[token]);
    }

    /**
     * @notice Amount of `token` currently releasable: vested but not yet released.
     */
    function releasable(address token) external view returns (uint256) {
        LaunchVest storage v = _vaults[token];
        return v.vestedUnreleased + _previewNewlyVested(v, block.timestamp);
    }

    /**
     * @notice Returns the immutable terms for the token's active vesting epoch.
     */
    function vestingTerms(address token)
        external
        view
        returns (address creatorRecipient, address protocolRecipient, uint16 protocolFeeShareBps)
    {
        LaunchVest storage v = _vaults[token];
        return (v.creatorRecipient, v.protocolRecipient, v.protocolFeeShareBps);
    }

    /**
     * @dev Linear vest over VESTING_DURATION from the launch's current
     * weighted-average start time, capped at the total ever locked.
     */
    function _vestedAmount(LaunchVest storage v) private view returns (uint256) {
        return v.totalReleased + v.vestedUnreleased + _previewNewlyVested(v, block.timestamp);
    }

    /**
     * @dev Crystallizes the linear portion vested since the previous state
     * update while preserving the existing schedule's maturity.
     */
    function _checkpoint(LaunchVest storage v, uint256 nowTs) private {
        uint256 newlyVested = _previewNewlyVested(v, nowTs);
        if (newlyVested != 0) {
            v.unvestedAmount -= newlyVested;
            v.vestedUnreleased += newlyVested;
        }
        v.lastUpdate = nowTs;
    }

    /**
     * @dev Previews how much of the active schedule vested since lastUpdate.
     */
    function _previewNewlyVested(LaunchVest storage v, uint256 nowTs) private view returns (uint256) {
        if (v.unvestedAmount == 0 || nowTs <= v.lastUpdate) return 0;
        if (nowTs >= v.vestingEnd) return v.unvestedAmount;

        uint256 remainingDuration = v.vestingEnd - v.lastUpdate;
        uint256 elapsed = nowTs - v.lastUpdate;
        return (v.unvestedAmount * elapsed) / remainingDuration;
    }

    /**
     * @dev A new epoch begins only after every token in the prior epoch has
     * been released. This keeps every active weighted-average vest bound to
     * one immutable set of beneficiaries without unbounded tranche storage.
     */
    function _setOrValidateVestingTerms(
        LaunchVest storage v,
        address token,
        address creatorRecipient,
        address protocolRecipient,
        uint16 protocolFeeShareBps
    ) private {
        bool newEpoch = v.unvestedAmount == 0 && v.vestedUnreleased == 0;
        if (newEpoch) {
            // Seed the buyback beneficiary only when it has never been set.
            // Once the factory has redirected the vest through
            // updateCreatorRecipient (a creator transfer or a protocol
            // recovery override), a later lock must not silently reset it
            // back to the launch-time recipient, even across a fresh epoch.
            if (v.creatorRecipient == address(0)) {
                v.creatorRecipient = creatorRecipient;
            }
            v.protocolRecipient = protocolRecipient;
            v.protocolFeeShareBps = protocolFeeShareBps;
            emit VestingTermsSnapshotted(token, v.creatorRecipient, protocolRecipient, protocolFeeShareBps);
            return;
        }

        // The creator recipient is deliberately excluded from this check: it
        // is managed independently through updateCreatorRecipient, so recovery
        // can move the vest without ever bricking a subsequent lock on a terms
        // mismatch. The protocol split terms remain immutable per launch.
        if (v.protocolRecipient != protocolRecipient || v.protocolFeeShareBps != protocolFeeShareBps) {
            revert VestingTermsMismatch();
        }
    }

    /**
     * @dev The shared meme hook is authorized for every pool it governs
     * (it IS `feePolicy`, checked directly). Pre-graduation, `token`'s own
     * bonding curve is authorized by looking its address up live from the
     * factory's launch record, so no per-launch admin action is ever
     * needed to allow a fresh launch's curve to lock its own buybacks.
     */
    function _isAuthorizedLocker(address token, address caller) private view returns (bool) {
        if (caller == address(feePolicy)) return true;
        if (factory == address(0)) return false;
        return caller == IBuilderPadLaunchFactory(factory).getLaunchedToken(token).curve;
    }
}
