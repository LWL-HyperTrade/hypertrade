// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {BuilderPadLaunchLocker} from "../src/BuilderPadLaunchLocker.sol";
import {BuilderPadFeeEscrow} from "../src/BuilderPadFeeEscrow.sol";
import {BuilderPadMemeHook} from "../src/hooks/BuilderPadMemeHook.sol";
import {BuilderPadBuybackVault} from "../src/BuilderPadBuybackVault.sol";
import {BuilderPadLaunchFactory} from "../src/BuilderPadLaunchFactory.sol";
import {BuilderPadLaunchDeployer} from "../src/BuilderPadLaunchDeployer.sol";
import {BuilderPadGraduationExecutor} from "../src/BuilderPadGraduationExecutor.sol";
import {BuilderPadLaunchAndBuy} from "../src/BuilderPadLaunchAndBuy.sol";
import {IBuilderPadFeeEscrow, IBuilderPadFeePolicy} from "../src/interfaces/ILaunchpadV2.sol";

import {Config} from "./Config.sol";
import {HookMiner} from "./HookMiner.sol";

/**
 * @title StackDeployer
 * @notice Deploy / wire / assert the 9-contract stack. Shared by the
 * broadcast script and the fork tests so both exercise identical code.
 * Contains no `vm` usage.
 */
abstract contract StackDeployer {
    struct Externals {
        address poolManager;
        address positionManager;
        address permit2;
        address protocolFeeRecipient;
        /// Address that executes CREATE2 for the hook: forge's deterministic
        /// deployer in scripts, `address(this)` in tests.
        address create2Deployer;
    }

    struct Stack {
        BuilderPadLaunchLocker locker;
        BuilderPadFeeEscrow escrow;
        BuilderPadMemeHook hook;
        BuilderPadBuybackVault vault;
        BuilderPadLaunchFactory factory;
        BuilderPadLaunchDeployer deployer;
        BuilderPadGraduationExecutor executor;
        address guard;
        BuilderPadLaunchAndBuy launchAndBuy;
    }

    function deployStack(address owner, Externals memory x, bool verbose) internal returns (Stack memory s) {
        // 1. Locker
        s.locker = new BuilderPadLaunchLocker(owner, x.positionManager);
        // 2. Fee escrow
        s.escrow = new BuilderPadFeeEscrow(owner);
        // 3. Meme hook — CREATE2 with mined salt so the address carries the v4 flags
        bytes memory ctorArgs =
            abi.encode(IPoolManager(x.poolManager), IBuilderPadFeeEscrow(s.escrow), x.protocolFeeRecipient, owner);
        (address predicted, bytes32 salt) =
            HookMiner.find(x.create2Deployer, Config.HOOK_FLAGS, type(BuilderPadMemeHook).creationCode, ctorArgs);
        s.hook = new BuilderPadMemeHook{salt: salt}(
            IPoolManager(x.poolManager), IBuilderPadFeeEscrow(s.escrow), x.protocolFeeRecipient, owner
        );
        require(address(s.hook) == predicted, "StackDeployer: hook address mismatch");
        // 4. Buyback vault (fee policy == hook)
        s.vault = new BuilderPadBuybackVault(owner, IBuilderPadFeePolicy(address(s.hook)), IBuilderPadFeeEscrow(s.escrow));
        // 5. Factory (deploys BuilderPadGraduationGuard in its constructor)
        s.factory = new BuilderPadLaunchFactory(
            owner,
            IPoolManager(x.poolManager),
            IPositionManager(x.positionManager),
            IAllowanceTransfer(x.permit2),
            s.locker,
            s.hook,
            IBuilderPadFeeEscrow(s.escrow),
            s.vault,
            Config.LAUNCH_FEE
        );
        s.guard = address(s.factory.graduationGuard());
        // 6. Launch deployer
        s.deployer = new BuilderPadLaunchDeployer(address(s.factory));
        // 7. Graduation executor
        s.executor = new BuilderPadGraduationExecutor(
            IPositionManager(x.positionManager), IAllowanceTransfer(x.permit2), s.locker, address(s.factory)
        );
        // 9. Launch-and-buy router
        s.launchAndBuy = new BuilderPadLaunchAndBuy(s.factory, owner);

        if (verbose) {
            console2.log("1 BuilderPadLaunchLocker", address(s.locker));
            console2.log("2 BuilderPadFeeEscrow", address(s.escrow));
            console2.log("3 BuilderPadMemeHook", address(s.hook));
            console2.log("4 BuilderPadBuybackVault", address(s.vault));
            console2.log("5 BuilderPadLaunchFactory", address(s.factory));
            console2.log("6 BuilderPadLaunchDeployer", address(s.deployer));
            console2.log("7 BuilderPadGraduationExecutor", address(s.executor));
            console2.log("8 BuilderPadGraduationGuard (by factory)", s.guard);
            console2.log("9 BuilderPadLaunchAndBuy", address(s.launchAndBuy));
        }
    }

    /// @dev Must be called by `owner`.
    function wireStack(Stack memory s, bool approvePairTokens, bool verbose) internal {
        // Escrow authorization
        s.escrow.setFactory(address(s.factory));
        s.escrow.setHook(address(s.hook));
        s.escrow.setBuybackVault(address(s.vault));

        // One-time factory wiring on the singletons
        s.locker.setFactory(address(s.factory));
        s.vault.setFactory(address(s.factory));
        s.hook.setFactory(address(s.factory));
        s.hook.setBuybackVault(s.vault);

        // Hook economics (protocol/creator split, buyback slice, hook fee)
        s.hook.setProtocolFeeShareBps(Config.PROTOCOL_FEE_SHARE_BPS);
        s.hook.setBuybackBurnBps(Config.BUYBACK_BURN_BPS);
        s.hook.setHookFeeBps(Config.HOOK_FEE_BPS);
        s.hook.setMaxInternalPriceImpactBps(Config.MAX_INTERNAL_PRICE_IMPACT_BPS);

        // Factory helpers
        s.factory.setLaunchDeployer(s.deployer);
        s.factory.setGraduationExecutor(s.executor);
        s.factory.setLaunchForwarder(address(s.launchAndBuy));

        // Launch config 0 (native ETH quote)
        uint256 id = s.factory.addLaunchConfig(
            BuilderPadLaunchFactory.LaunchConfig({
                supply: Config.LAUNCH_SUPPLY,
                curveFeeBps: Config.CURVE_FEE_BPS,
                phantomQuote: Config.NATIVE_PHANTOM_QUOTE,
                graduationThreshold: Config.NATIVE_GRADUATION_THRESHOLD,
                poolFee: Config.POOL_FEE,
                tickSpacing: Config.TICK_SPACING,
                enabled: true
            })
        );
        require(id == 0, "StackDeployer: launch config id != 0");

        // Creator tax ceiling + anti-snipe (live Pons values)
        s.factory.setMaxCreatorTaxBps(Config.MAX_CREATOR_TAX_BPS);
        s.factory.setSnipeTaxStartBps(Config.SNIPE_TAX_START_BPS);
        s.factory.setSnipeTaxSeconds(Config.SNIPE_TAX_SECONDS);

        // ERC-20 quote assets — only where the token exists on this chain
        if (approvePairTokens) {
            Config.PairToken[] memory list = Config.pairTokens();
            for (uint256 i = 0; i < list.length; i++) {
                Config.PairToken memory p = list[i];
                if (p.token.code.length == 0) {
                    if (verbose) console2.log("skip pair token (no code)", p.symbol, p.token);
                    continue;
                }
                s.factory.setPairTokenEconomics(p.token, p.phantomQuote, p.graduationThreshold, p.decimals);
                s.factory.setPairTokenApproved(p.token, true);
                if (verbose) console2.log("approved pair token", p.symbol, p.token);
            }
        }

        // Public launches (matches live Pons `launchEnabled == true`)
        s.factory.setLaunchEnabled(true);
    }

    function assertStack(Stack memory s, address feeRecipient, bool checkPairTokens) internal view {
        // Hook policy
        require(s.hook.protocolFeeShareBps() == Config.PROTOCOL_FEE_SHARE_BPS, "cfg: protocolFeeShareBps");
        require(s.hook.buybackBurnBps() == Config.BUYBACK_BURN_BPS, "cfg: buybackBurnBps");
        require(s.hook.hookFeeBps() == Config.HOOK_FEE_BPS, "cfg: hookFeeBps");
        require(
            s.hook.maxInternalPriceImpactBps() == Config.MAX_INTERNAL_PRICE_IMPACT_BPS, "cfg: maxInternalPriceImpactBps"
        );
        require(s.hook.protocolFeeRecipient() == feeRecipient, "cfg: protocolFeeRecipient");
        require(s.hook.factory() == address(s.factory), "cfg: hook.factory");
        require(address(s.hook.buybackVault()) == address(s.vault), "cfg: hook.buybackVault");
        require(address(s.hook.feeEscrow()) == address(s.escrow), "cfg: hook.feeEscrow");

        // Factory
        require(s.factory.launchFee() == Config.LAUNCH_FEE, "cfg: launchFee");
        require(s.factory.maxCreatorTaxBps() == Config.MAX_CREATOR_TAX_BPS, "cfg: maxCreatorTaxBps");
        require(s.factory.snipeTaxStartBps() == Config.SNIPE_TAX_START_BPS, "cfg: snipeTaxStartBps");
        require(s.factory.snipeTaxSeconds() == Config.SNIPE_TAX_SECONDS, "cfg: snipeTaxSeconds");
        require(s.factory.launchEnabled(), "cfg: launchEnabled");
        require(address(s.factory.launchDeployer()) == address(s.deployer), "cfg: launchDeployer");
        require(address(s.factory.graduationExecutor()) == address(s.executor), "cfg: graduationExecutor");
        require(s.factory.launchForwarder() == address(s.launchAndBuy), "cfg: launchForwarder");
        require(s.factory.launchConfigCount() == 1, "cfg: launchConfigCount");
        BuilderPadLaunchFactory.LaunchConfig memory c = s.factory.getLaunchConfig(0);
        require(c.supply == Config.LAUNCH_SUPPLY, "cfg: supply");
        require(c.curveFeeBps == Config.CURVE_FEE_BPS, "cfg: curveFeeBps");
        require(c.phantomQuote == Config.NATIVE_PHANTOM_QUOTE, "cfg: phantomQuote");
        require(c.graduationThreshold == Config.NATIVE_GRADUATION_THRESHOLD, "cfg: graduationThreshold");
        require(c.poolFee == Config.POOL_FEE, "cfg: poolFee");
        require(c.tickSpacing == Config.TICK_SPACING, "cfg: tickSpacing");
        require(c.enabled, "cfg: enabled");

        // Singletons
        require(s.locker.factory() == address(s.factory), "cfg: locker.factory");
        require(s.vault.factory() == address(s.factory), "cfg: vault.factory");
        require(s.escrow.factory() == address(s.factory), "cfg: escrow.factory");
        require(s.escrow.hook() == address(s.hook), "cfg: escrow.hook");
        require(s.escrow.buybackVault() == address(s.vault), "cfg: escrow.vault");
        require(address(s.launchAndBuy.factory()) == address(s.factory), "cfg: launchAndBuy.factory");

        if (checkPairTokens) {
            Config.PairToken[] memory list = Config.pairTokens();
            for (uint256 i = 0; i < list.length; i++) {
                if (list[i].token.code.length == 0) continue;
                require(s.factory.approvedPairTokens(list[i].token), "cfg: pair not approved");
                (uint256 ph, uint256 th, uint8 dec) = s.factory.pairTokenEconomics(list[i].token);
                require(
                    ph == list[i].phantomQuote && th == list[i].graduationThreshold && dec == list[i].decimals,
                    "cfg: pair economics"
                );
            }
        }
    }
}
