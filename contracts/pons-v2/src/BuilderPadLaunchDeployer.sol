// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {BuilderPadLauncherToken} from "./BuilderPadLauncherToken.sol";
import {BuilderPadBondingCurve} from "./BuilderPadBondingCurve.sol";
import {BuilderPadBuybackVault} from "./BuilderPadBuybackVault.sol";
import {FeePolicySnapshot, IBuilderPadFeeEscrow, IBuilderPadFeePolicy} from "./interfaces/ILaunchpadV2.sol";

/**
 * @notice Every input BuilderPadLaunchFactory hands the deployer to stand up one
 * launch. Grouped into a single calldata struct rather than a flat parameter
 * list so the deployer stays inside the EVM's 16-slot stack window when
 * compiled without the IR pipeline, which is the mode `forge coverage` uses.
 */
struct LaunchDeployment {
    address pairToken;
    address creatorFeeRecipient;
    address originalDeployer;
    IBuilderPadFeePolicy feePolicy;
    FeePolicySnapshot policy;
    IBuilderPadFeeEscrow feeEscrow;
    BuilderPadBuybackVault buybackVault;
    uint256 phantomQuote;
    uint256 curveFeeBps;
    uint256 creatorTaxBps;
    bool buybackEnabled;
    uint256 graduationThreshold;
    uint256 supply;
    // Creator-chosen CREATE2 salt, forwarded from TokenParams. The factory
    // authenticates `originalDeployer`, which gives each initiating account
    // its own salt space even when it names a separate fee recipient.
    bytes32 salt;
    string name;
    string symbol;
    string logo;
    string description;
    BuilderPadLauncherToken.Socials socials;
}

/**
 * @title BuilderPadLaunchDeployer
 * @notice Deploys the bonding curve and launch token pair for one pons v2
 * launch on BuilderPadLaunchFactory's behalf. Split out into its own contract
 * purely so BuilderPadLaunchFactory's own bytecode stays under EIP-170's
 * 24576-byte deployed-code limit: embedding two full contracts' creation
 * code via `new` inside the factory itself was the single largest
 * contributor to its size. Both new contracts still record the real
 * factory's address explicitly (never this deployer's), since they gate
 * privileged calls on it.
 */
contract BuilderPadLaunchDeployer {
    // Metadata is stored on the token and read back by unbounded-return view
    // functions, so an unbounded write here becomes a permanently unreadable
    // token: `socials()` returns all five strings at once and would run out
    // of gas or time out an RPC node. Bounding the write is the only place
    // the limit can be enforced, since the strings are immutable afterwards.
    uint256 private constant MAX_NAME_LENGTH = 64;
    uint256 private constant MAX_SYMBOL_LENGTH = 16;
    uint256 private constant MAX_LOGO_LENGTH = 512;
    uint256 private constant MAX_DESCRIPTION_LENGTH = 2048;
    uint256 private constant MAX_SOCIAL_LENGTH = 256;

    error NotFactory();
    error MetadataTooLong();

    address public immutable factory;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    /**
     * @notice Deploys a fresh curve/token pair and returns both addresses.
     * Both contracts are told `factory` (not this deployer) is their
     * privileged caller. Wiring the curve to its token via `initialize()` is
     * left to the factory itself, since that call is `onlyFactory`-gated.
     *
     * @dev Deployed with CREATE2 rather than CREATE so neither address depends
     * on this deployer's nonce, and therefore on the order launches happen to
     * land in. Under CREATE the Nth launch simply took the Nth address, so an
     * address predicted before its launch confirmed committed to nothing and
     * a different launch could arrive there instead. Under CREATE2 the address
     * is a function of the salt and the creation code, and the creation code
     * carries every constructor argument, so an address can only ever hold the
     * exact launch it was computed from.
     *
     * Reverts through `Create2` with `FailedDeployment` when the pair already
     * exists, which is the same creator reusing a salt on otherwise identical
     * terms. Callers can test for it in advance with `predictLaunchAddresses`.
     */
    function deployLaunch(LaunchDeployment calldata params)
        external
        onlyFactory
        returns (address token, address curve)
    {
        _requireMetadataWithinLimits(params);

        bytes32 salt = _launchSalt(params);
        curve = Create2.deploy(0, salt, _curveCreationCode(params));
        token = Create2.deploy(0, salt, _tokenCreationCode(params, curve));
    }

    /**
     * @notice Returns the addresses `deployLaunch` would produce for `params`,
     * without deploying anything.
     *
     * @dev Lets a caller confirm that a launch it has not seen confirmed yet
     * will land where it expects, and lets the launch path be checked for a
     * salt the creator has already used. The token is derived from the curve
     * because the curve's address is one of the token's constructor
     * arguments, so the pair has to be computed in deployment order.
     */
    function predictLaunchAddresses(LaunchDeployment calldata params)
        external
        view
        returns (address token, address curve)
    {
        bytes32 salt = _launchSalt(params);
        curve = Create2.computeAddress(salt, keccak256(_curveCreationCode(params)));
        token = Create2.computeAddress(salt, keccak256(_tokenCreationCode(params, curve)));
    }

    /**
     * @dev CREATE2 salt for one launch: the creator's chosen salt namespaced
     * by the factory-authenticated initiating account. `creatorFeeRecipient`
     * is intentionally not the namespace because any caller may name an
     * arbitrary payout address and could otherwise squat another creator's
     * deployment.
     */
    function _launchSalt(LaunchDeployment calldata params) private pure returns (bytes32) {
        return keccak256(abi.encode(params.originalDeployer, params.salt));
    }

    /**
     * @dev Creation code for the launch's bonding curve. Shared by the deploy
     * and predict paths so the two can never derive different addresses.
     */
    function _curveCreationCode(LaunchDeployment calldata params) private view returns (bytes memory) {
        return abi.encodePacked(
            type(BuilderPadBondingCurve).creationCode,
            abi.encode(
                params.pairToken,
                params.creatorFeeRecipient,
                factory,
                params.feePolicy,
                params.policy,
                params.feeEscrow,
                params.buybackVault,
                params.phantomQuote,
                params.curveFeeBps,
                params.creatorTaxBps,
                params.buybackEnabled,
                params.graduationThreshold
            )
        );
    }

    /**
     * @dev Creation code for the launch's token, given the curve it mints its
     * whole supply to.
     */
    function _tokenCreationCode(LaunchDeployment calldata params, address curve) private view returns (bytes memory) {
        return abi.encodePacked(
            type(BuilderPadLauncherToken).creationCode,
            abi.encode(
                params.name,
                params.symbol,
                params.logo,
                params.description,
                params.socials,
                params.originalDeployer,
                curve,
                factory,
                params.supply
            )
        );
    }

    /**
     * @notice Reverts unless every metadata string fits its length cap.
     * @dev The factory already rejects an empty name or symbol, so only the
     * upper bound is checked here.
     */
    function _requireMetadataWithinLimits(LaunchDeployment calldata params) private pure {
        if (
            bytes(params.name).length > MAX_NAME_LENGTH || bytes(params.symbol).length > MAX_SYMBOL_LENGTH
                || bytes(params.logo).length > MAX_LOGO_LENGTH
                || bytes(params.description).length > MAX_DESCRIPTION_LENGTH
        ) {
            revert MetadataTooLong();
        }
        if (
            bytes(params.socials.twitter).length > MAX_SOCIAL_LENGTH
                || bytes(params.socials.telegram).length > MAX_SOCIAL_LENGTH
                || bytes(params.socials.discord).length > MAX_SOCIAL_LENGTH
                || bytes(params.socials.website).length > MAX_SOCIAL_LENGTH
                || bytes(params.socials.farcaster).length > MAX_SOCIAL_LENGTH
        ) {
            revert MetadataTooLong();
        }
    }
}
