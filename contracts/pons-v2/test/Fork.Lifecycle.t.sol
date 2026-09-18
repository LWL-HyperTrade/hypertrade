// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import {BuilderPadLaunchFactory} from "../src/BuilderPadLaunchFactory.sol";
import {BuilderPadBondingCurve} from "../src/BuilderPadBondingCurve.sol";
import {BuilderPadLauncherToken} from "../src/BuilderPadLauncherToken.sol";
import {IBuilderPadLaunchFactory, GraduationPhase} from "../src/interfaces/ILaunchpadV2.sol";

import {Config} from "../script/Config.sol";
import {StackDeployer} from "../script/StackDeployer.sol";
import {SimpleSwapRouter} from "./utils/SimpleSwapRouter.sol";

/**
 * @notice Fork tests against live Robinhood Chain (real Uniswap v4 PoolManager /
 * PositionManager / Permit2). Deploys our full stack with `StackDeployer`,
 * then drives launch → curve trading → sweep → graduation → v4 pool → hook
 * swap, asserting fee conservation and the 10/90 (+25% buyback) split.
 *
 * RPC: `ROBINHOOD_RPC_URL` if set (contracts/pons-v2/.env), else the public endpoint.
 */
contract ForkLifecycleTest is Test, StackDeployer {
    using PoolIdLibrary for PoolKey;

    Stack s;
    address owner; // == address(this): deployer, factory owner, fee sweep operator
    address creator = makeAddr("creator");
    address trader1 = makeAddr("trader1");
    address trader2 = makeAddr("trader2");
    address feeRecipient = Config.PROTOCOL_FEE_RECIPIENT;

    bytes32 constant CURVE_BUY_SIG =
        keccak256("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
    bytes32 constant CURVE_SELL_SIG =
        keccak256("CurveSell(address,address,uint256,uint256,uint256,uint256)");
    bytes32 constant FEES_SWEPT_SIG = keccak256("FeesSwept(uint256,uint256,uint256)");

    function setUp() public {
        // Prefer ROBINHOOD_RPC_URL (contracts/pons-v2/.env). Public is the fallback only.
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpc);
        assertEq(block.chainid, Config.ROBINHOOD_CHAIN_ID, "fork must be Robinhood mainnet");

        owner = address(this);
        Externals memory x = Externals({
            poolManager: Config.POOL_MANAGER,
            positionManager: Config.POSITION_MANAGER,
            permit2: Config.PERMIT2,
            protocolFeeRecipient: feeRecipient,
            create2Deployer: address(this) // `new {salt}` from a test contract CREATE2s from the test contract
        });
        s = deployStack(owner, x, false);
        wireStack(s, false, false); // pair tokens covered by the deploy dry-run; native quote here
        assertStack(s, feeRecipient, false);

        vm.deal(creator, 100 ether);
        vm.deal(trader1, 100 ether);
        vm.deal(trader2, 100 ether);
    }

    // ------------------------------------------------------------------ //
    // Helpers
    // ------------------------------------------------------------------ //

    function _params(uint16 creatorTaxBps, bool buyback, bytes32 salt)
        internal
        view
        returns (BuilderPadLaunchFactory.TokenParams memory p)
    {
        p.name = "Fork Test";
        p.symbol = "FORK";
        p.logo = "ipfs://logo";
        p.description = "fork lifecycle test";
        p.socials = BuilderPadLauncherToken.Socials("", "", "", "", "");
        p.creatorFeeRecipient = creator;
        p.creatorTaxBps = creatorTaxBps;
        p.buybackEnabled = buyback;
        p.expectedEconomics = s.factory.previewLaunchEconomics(0, address(0));
        p.salt = salt;
    }

    function _launch(uint16 creatorTaxBps, bool buyback) internal returns (address token, BuilderPadBondingCurve curve) {
        // Build params first: `_params` does an external view call which would otherwise eat the prank.
        BuilderPadLaunchFactory.TokenParams memory p =
            _params(creatorTaxBps, buyback, keccak256(abi.encode(creatorTaxBps, buyback, block.number)));
        vm.prank(creator);
        (address t, address c) = s.factory.launchToken{value: Config.LAUNCH_FEE}(p, 0, address(0));
        token = t;
        curve = BuilderPadBondingCurve(payable(c));
        // Clear the anti-snipe window so buys are priced at base fee only.
        vm.warp(block.timestamp + Config.SNIPE_TAX_SECONDS + 10);
    }

    function _buy(BuilderPadBondingCurve curve, address who, uint256 eth) internal returns (uint256 out) {
        vm.prank(who);
        out = curve.buy{value: eth}(eth, 0, who);
    }

    function _sell(BuilderPadBondingCurve curve, address token, address who, uint256 tokens) internal returns (uint256 out) {
        vm.startPrank(who);
        IERC20(token).approve(address(curve), tokens);
        out = curve.sell(tokens, 0, who);
        vm.stopPrank();
    }

    /// Sum fee/tax from CurveBuy/CurveSell logs recorded since `vm.recordLogs()`.
    function _sumCurveFees(Vm.Log[] memory logs, address curve)
        internal
        pure
        returns (uint256 fee, uint256 tax, uint256 spent)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != curve) continue;
            if (logs[i].topics[0] == CURVE_BUY_SIG) {
                (uint256 quoteIn,, uint256 f, uint256 t) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                fee += f;
                tax += t;
                spent += quoteIn;
            } else if (logs[i].topics[0] == CURVE_SELL_SIG) {
                (, uint256 quoteOut, uint256 f, uint256 t) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                fee += f;
                tax += t;
                spent += quoteOut + f + t; // gross
            }
        }
    }

    function _findFeesSwept(Vm.Log[] memory logs, address curve)
        internal
        pure
        returns (bool found, uint256 protocolAmt, uint256 buybackAmt, uint256 creatorAmt)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == curve && logs[i].topics[0] == FEES_SWEPT_SIG) {
                (protocolAmt, buybackAmt, creatorAmt) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                return (true, protocolAmt, buybackAmt, creatorAmt);
            }
        }
    }

    function _poolKey(address token) internal view returns (PoolKey memory) {
        // Native ETH (address 0) always sorts first.
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: Config.POOL_FEE,
            tickSpacing: Config.TICK_SPACING,
            hooks: IHooks(address(s.hook))
        });
    }

    // ------------------------------------------------------------------ //
    // 1. Launch terms are what Config says
    // ------------------------------------------------------------------ //

    function test_launch_snapshotsOurEconomics() public {
        uint256 feeRecipientBefore = feeRecipient.balance;
        (address token, BuilderPadBondingCurve curve) = _launch(0, false);
        IBuilderPadLaunchFactory.LaunchedToken memory l = s.factory.getLaunchedToken(token);
        assertTrue(l.exists);
        assertEq(l.curve, address(curve));
        assertEq(l.deployer, creator);
        assertEq(l.graduationThreshold, Config.NATIVE_GRADUATION_THRESHOLD);
        assertEq(l.poolFee, Config.POOL_FEE);
        assertEq(l.tickSpacing, Config.TICK_SPACING);
        assertEq(curve.feeBps(), Config.CURVE_FEE_BPS);
        assertEq(curve.creatorTaxBps(), 0);
        assertEq(curve.protocolFeeShareBps(), Config.PROTOCOL_FEE_SHARE_BPS);
        assertEq(curve.buybackBurnBps(), Config.BUYBACK_BURN_BPS);
        assertFalse(curve.buybackEnabled());
        assertEq(IERC20(token).totalSupply(), Config.LAUNCH_SUPPLY);
        assertEq(IERC20(token).balanceOf(address(curve)), Config.LAUNCH_SUPPLY);
        // Launch fee landed with the protocol fee recipient.
        assertEq(feeRecipient.balance - feeRecipientBefore, Config.LAUNCH_FEE, "launch fee paid to protocol");
    }

    function test_launch_wrongFeeReverts() public {
        BuilderPadLaunchFactory.TokenParams memory p = _params(0, false, bytes32(uint256(1)));
        vm.prank(creator);
        vm.expectRevert();
        s.factory.launchToken{value: Config.LAUNCH_FEE - 1}(p, 0, address(0));
    }

    function test_launch_creatorTaxAboveCapReverts() public {
        BuilderPadLaunchFactory.TokenParams memory p =
            _params(uint16(Config.MAX_CREATOR_TAX_BPS + 1), false, bytes32(uint256(2)));
        vm.prank(creator);
        vm.expectRevert();
        s.factory.launchToken{value: Config.LAUNCH_FEE}(p, 0, address(0));
    }

    function test_launch_defaultsMatchWebWizard() public view {
        // Buyback default OFF is a per-launch TokenParams choice (web default), not a contract setting;
        // the contract-side defaults we can assert are the fee terms every launch snapshots.
        assertEq(s.factory.maxCreatorTaxBps(), Config.MAX_CREATOR_TAX_BPS);
        assertEq(s.factory.launchFee(), Config.LAUNCH_FEE);
        assertTrue(s.factory.canLaunch(creator), "public launches enabled");
    }

    // ------------------------------------------------------------------ //
    // 2. Curve fee conservation — base fee only, 10/90 split
    // ------------------------------------------------------------------ //

    function test_curve_feeConservation_baseFee() public {
        (address token, BuilderPadBondingCurve curve) = _launch(0, false);

        vm.recordLogs();
        uint256 t1 = _buy(curve, trader1, 0.5 ether);
        _buy(curve, trader2, 0.25 ether);
        _sell(curve, token, trader1, t1 / 2);
        _buy(curve, trader1, 0.1 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256 feeSum, uint256 taxSum, uint256 gross) = _sumCurveFees(logs, address(curve));
        assertGt(feeSum, 0);
        assertEq(taxSum, 0, "no creator tax configured");
        // Every trade charged exactly 75 bps of its quote leg (per-trade floor rounding).
        assertApproxEqAbs(feeSum, (gross * Config.CURVE_FEE_BPS) / Config.BASIS_POINTS, 4);
        assertEq(curve.quoteFeeBalance(), feeSum, "pending fee balance == sum of trade fees");
        assertEq(curve.creatorTaxBalance(), 0);
        assertEq(curve.buybackQuoteBalance(), 0, "buyback off: nothing earmarked");

        // Sweep as creator (allowed when no internal buyback is needed).
        uint256 protoBefore = s.escrow.balanceOf(feeRecipient);
        uint256 creatorBefore = s.escrow.balanceOf(creator);
        vm.recordLogs();
        vm.prank(creator);
        curve.sweepFees(0);
        (bool found, uint256 p, uint256 b, uint256 c) = _findFeesSwept(vm.getRecordedLogs(), address(curve));
        assertTrue(found);

        uint256 expectedProtocol = (feeSum * Config.PROTOCOL_FEE_SHARE_BPS) / Config.BASIS_POINTS;
        assertEq(p, expectedProtocol, "protocol = 10% of fees");
        assertEq(b, 0);
        assertEq(c, feeSum - expectedProtocol, "creator = 90% of fees");
        assertEq(p + b + c, feeSum, "conservation: split sums to pending fees");

        assertEq(s.escrow.balanceOf(feeRecipient) - protoBefore, p);
        assertEq(s.escrow.balanceOf(creator) - creatorBefore, c);
        assertEq(curve.quoteFeeBalance(), 0);
        assertEq(address(s.escrow).balance, s.escrow.totalNative());

        // Creator can pull.
        uint256 bal = creator.balance;
        vm.prank(creator);
        s.escrow.claim();
        assertEq(creator.balance - bal, c);
    }

    // ------------------------------------------------------------------ //
    // 3. Creator tax + buyback: tax bypasses split; buyback = 25% of creator bucket
    // ------------------------------------------------------------------ //

    function test_curve_feeConservation_creatorTaxAndBuyback() public {
        uint16 taxBps = 500; // 5%
        (address token, BuilderPadBondingCurve curve) = _launch(taxBps, true);
        assertTrue(curve.buybackEnabled());
        assertEq(curve.creatorTaxBps(), taxBps);

        vm.recordLogs();
        uint256 t1 = _buy(curve, trader1, 0.4 ether);
        _buy(curve, trader2, 0.3 ether);
        _sell(curve, token, trader1, t1 / 3);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 feeSum, uint256 taxSum, uint256 gross) = _sumCurveFees(logs, address(curve));

        assertApproxEqAbs(feeSum, (gross * Config.CURVE_FEE_BPS) / Config.BASIS_POINTS, 4);
        assertApproxEqAbs(taxSum, (gross * taxBps) / Config.BASIS_POINTS, 4);
        assertEq(curve.quoteFeeBalance(), feeSum);
        assertEq(curve.creatorTaxBalance(), taxSum);

        // Earmark accrues per trade: Σ (creatorSlice_i * 2500 / 1e4); within rounding of the aggregate.
        uint256 creatorBucket = feeSum - (feeSum * Config.PROTOCOL_FEE_SHARE_BPS) / Config.BASIS_POINTS;
        uint256 expectedBuyback = (creatorBucket * Config.BUYBACK_BURN_BPS) / Config.BASIS_POINTS;
        assertApproxEqAbs(curve.buybackQuoteBalance(), expectedBuyback, 8);

        // Buyback requires the trusted operator (owner). Creator must be refused.
        vm.prank(creator);
        vm.expectRevert(BuilderPadBondingCurve.InternalSwapRequiresOperator.selector);
        curve.sweepFees(1);

        uint256 lockedBefore = s.vault.totalLocked(token);
        vm.recordLogs();
        curve.sweepFees(1); // owner == feeSweepOperator
        (bool found, uint256 p, uint256 b, uint256 c) = _findFeesSwept(vm.getRecordedLogs(), address(curve));
        assertTrue(found);

        uint256 expectedProtocol = (feeSum * Config.PROTOCOL_FEE_SHARE_BPS) / Config.BASIS_POINTS;
        assertEq(p, expectedProtocol, "protocol = 10% of base fee (tax excluded)");
        assertGt(b, 0, "buyback executed");
        assertLe(b, expectedBuyback, "buyback never exceeds 25% of creator bucket");
        assertEq(c, feeSum - expectedProtocol - b + taxSum, "creator = 90% - buyback + 100% of tax");
        assertEq(p + b + c, feeSum + taxSum, "conservation: everything charged is distributed");

        assertGt(s.vault.totalLocked(token), lockedBefore, "bought-back tokens locked in vault");
        assertEq(s.escrow.balanceOf(feeRecipient), p);
        assertEq(s.escrow.balanceOf(creator), c);
        assertEq(curve.quoteFeeBalance(), 0);
        assertEq(curve.creatorTaxBalance(), 0);
        assertEq(curve.buybackQuoteBalance(), 0);
    }

    // ------------------------------------------------------------------ //
    // 4. Graduation → real v4 pool → hook fee 75 bps, 10/90
    // ------------------------------------------------------------------ //

    function test_graduation_and_hookFeeSplit() public {
        (address token, BuilderPadBondingCurve curve) = _launch(0, false);

        // Buy the curve out. Oversized buy is clamped to the sellable allocation and refunded.
        vm.deal(trader1, 50 ether);
        vm.prank(trader1);
        curve.buy{value: 20 ether}(20 ether, 0, trader1);
        assertTrue(curve.graduated() || curve.readyToGraduate(), "curve exhausted");

        IBuilderPadLaunchFactory.LaunchedToken memory l = s.factory.getLaunchedToken(token);
        if (l.phase == GraduationPhase.NotGraduated) {
            s.factory.graduate(token); // auto-graduate may be gas-starved; permissionless retry
            l = s.factory.getLaunchedToken(token);
        }
        assertEq(uint8(l.phase), uint8(GraduationPhase.Swept), "phase: Swept");
        assertTrue(curve.graduated());
        assertEq(curve.quoteFeeBalance(), 0, "graduation swept curve fees");
        // Fees from the crossing buy were split 10/90 into the escrow.
        uint256 protoAfterCurve = s.escrow.balanceOf(feeRecipient);
        uint256 creatorAfterCurve = s.escrow.balanceOf(creator);
        assertGt(protoAfterCurve, 0);
        assertGt(creatorAfterCurve, 0);
        assertApproxEqRel(
            protoAfterCurve * (Config.BASIS_POINTS - Config.PROTOCOL_FEE_SHARE_BPS),
            creatorAfterCurve * Config.PROTOCOL_FEE_SHARE_BPS,
            1e12, // 0.0001% — per-trade rounding only
            "curve sweep split is 10/90"
        );

        // Seed the v4 pool (permissionless).
        uint256 positionId = s.factory.createGraduatedPool(token);
        assertGt(positionId, 0);
        l = s.factory.getLaunchedToken(token);
        assertEq(uint8(l.phase), uint8(GraduationPhase.PoolCreated), "phase: PoolCreated");
        assertEq(s.locker.lockedPositions(token), positionId, "position NFT held by locker");

        PoolKey memory key = _poolKey(token);
        PoolId poolId = key.toId();
        (bool registered,, address memecoin, address quoteToken,,,,,,,,) = _launchInfo(poolId);
        assertTrue(registered, "hook registered the pool");
        assertEq(memecoin, token);
        assertEq(quoteToken, address(0));

        // Swap token -> ETH (exact in). Unspecified currency = ETH, so the hook
        // fee is taken in quote and needs no conversion at sweep.
        SimpleSwapRouter router = new SimpleSwapRouter(IPoolManager(Config.POOL_MANAGER));
        uint256 sellAmt = IERC20(token).balanceOf(trader1) / 10;
        vm.startPrank(trader1);
        IERC20(token).approve(address(router), sellAmt);
        BalanceDelta d = router.swapExactIn(key, false, sellAmt); // oneForZero: token(currency1) -> ETH(currency0)
        vm.stopPrank();

        int128 ethOutNet = d.amount0();
        assertGt(ethOutNet, 0, "trader received ETH");
        uint256 pending = s.hook.pendingFees(poolId, address(0));
        assertGt(pending, 0, "hook collected ETH fee");
        // fee = 75 bps of the gross unspecified amount; trader got gross - fee.
        uint256 gross = uint256(uint128(ethOutNet)) + pending;
        assertEq(pending, (gross * Config.HOOK_FEE_BPS) / Config.BASIS_POINTS, "hook fee = 75 bps of gross output");
        assertEq(s.hook.pendingCreatorTax(poolId, address(0)), 0);
        assertEq(s.hook.pendingBuyback(poolId, address(0)), 0, "buyback off");

        // Distribute: 10% protocol / 90% creator, all quote, no conversion needed.
        uint256 p0 = s.escrow.balanceOf(feeRecipient);
        uint256 c0 = s.escrow.balanceOf(creator);
        s.hook.sweepPoolFees(poolId, 0, 0);
        uint256 dp = s.escrow.balanceOf(feeRecipient) - p0;
        uint256 dc = s.escrow.balanceOf(creator) - c0;
        assertEq(dp, (pending * Config.PROTOCOL_FEE_SHARE_BPS) / Config.BASIS_POINTS, "hook protocol = 10%");
        assertEq(dc, pending - dp, "hook creator = 90%");
        assertEq(dp + dc, pending, "conservation");
        assertEq(s.hook.pendingFees(poolId, address(0)), 0);
        assertEq(address(s.escrow).balance, s.escrow.totalNative(), "escrow holds exactly what it owes");
    }

    /// Decode the public `launches(poolId)` getter.
    function _launchInfo(PoolId poolId)
        internal
        view
        returns (
            bool registered,
            bool memecoinIsCurrency0,
            address memecoin,
            address quoteToken,
            address creator_,
            address buybackCreatorRecipient,
            address protocolFeeRecipient,
            uint16 creatorTaxBps,
            uint16 protocolFeeShareBps,
            uint16 buybackBurnBps,
            uint16 hookFeeBps,
            uint16 maxInternalPriceImpactBps
        )
    {
        (bool ok, bytes memory ret) =
            address(s.hook).staticcall(abi.encodeWithSignature("launches(bytes32)", PoolId.unwrap(poolId)));
        require(ok, "launches() failed");
        // Decode only the leading fields we assert on; the struct may carry more.
        (registered, memecoinIsCurrency0, memecoin, quoteToken) = abi.decode(ret, (bool, bool, address, address));
        creator_ = address(0);
        buybackCreatorRecipient = address(0);
        protocolFeeRecipient = address(0);
        creatorTaxBps = 0;
        protocolFeeShareBps = 0;
        buybackBurnBps = 0;
        hookFeeBps = 0;
        maxInternalPriceImpactBps = 0;
    }

    receive() external payable {}
}
