// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BuilderPadFeeEscrow} from "../src/BuilderPadFeeEscrow.sol";
import {IBuilderPadFeeEscrow} from "../src/interfaces/ILaunchpadV2.sol";
import {
    MockERC20,
    FeeOnTransferERC20,
    MockFactory,
    MockCurve,
    MockCrediter,
    LyingCurve,
    RevertingTokenGetter,
    ReentrantClaimer,
    RejectingRecipient
} from "./mocks/Mocks.sol";

contract FeeEscrowTest is Test {
    BuilderPadFeeEscrow escrow;
    MockFactory factory;
    MockCrediter hook;
    MockCrediter vault;
    MockCurve curve;
    MockERC20 usd;
    address launchToken = address(0xBEEF);

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    function setUp() public {
        escrow = new BuilderPadFeeEscrow(owner);
        factory = new MockFactory();
        hook = new MockCrediter(escrow);
        vault = new MockCrediter(escrow);
        curve = new MockCurve(launchToken, escrow);
        factory.setCurve(launchToken, address(curve));
        usd = new MockERC20("USD", "USD", 6);

        vm.startPrank(owner);
        escrow.setFactory(address(factory));
        escrow.setHook(address(hook));
        escrow.setBuybackVault(address(vault));
        vm.stopPrank();

        vm.deal(address(hook), 100 ether);
        vm.deal(address(vault), 100 ether);
        vm.deal(address(curve), 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // ------------------------------------------------------------------ //
    // Wiring / ownership
    // ------------------------------------------------------------------ //

    function test_wiring_isOneTime() public {
        vm.startPrank(owner);
        vm.expectRevert(BuilderPadFeeEscrow.AlreadyInitialized.selector);
        escrow.setFactory(address(1));
        vm.expectRevert(BuilderPadFeeEscrow.AlreadyInitialized.selector);
        escrow.setHook(address(1));
        vm.expectRevert(BuilderPadFeeEscrow.AlreadyInitialized.selector);
        escrow.setBuybackVault(address(1));
        vm.stopPrank();
    }

    function test_wiring_onlyOwner() public {
        BuilderPadFeeEscrow fresh = new BuilderPadFeeEscrow(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        fresh.setFactory(address(factory));
    }

    function test_wiring_rejectsZero() public {
        BuilderPadFeeEscrow fresh = new BuilderPadFeeEscrow(owner);
        vm.startPrank(owner);
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAddress.selector);
        fresh.setFactory(address(0));
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAddress.selector);
        fresh.setHook(address(0));
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAddress.selector);
        fresh.setBuybackVault(address(0));
        vm.stopPrank();
    }

    function test_renounceOwnership_blocked() public {
        vm.prank(owner);
        vm.expectRevert(BuilderPadFeeEscrow.OwnershipCannotBeRenounced.selector);
        escrow.renounceOwnership();
    }

    function test_ownership_twoStep() public {
        vm.prank(owner);
        escrow.transferOwnership(alice);
        assertEq(escrow.owner(), owner);
        vm.prank(alice);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), alice);
    }

    // ------------------------------------------------------------------ //
    // Authorization
    // ------------------------------------------------------------------ //

    function test_auth_hookVaultCurve() public view {
        assertTrue(escrow.isAuthorizedCrediter(address(hook)));
        assertTrue(escrow.isAuthorizedCrediter(address(vault)));
        assertTrue(escrow.isAuthorizedCrediter(address(curve)));
    }

    function test_auth_eoaRejected() public {
        assertFalse(escrow.isAuthorizedCrediter(stranger));
        vm.prank(stranger);
        vm.expectRevert(BuilderPadFeeEscrow.NotAuthorizedCrediter.selector);
        escrow.credit{value: 1 ether}(alice);
    }

    function test_auth_ownerIsNotACrediter() public {
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        vm.expectRevert(BuilderPadFeeEscrow.NotAuthorizedCrediter.selector);
        escrow.credit{value: 1 ether}(alice);
    }

    function test_auth_lyingCurveRejected() public {
        // Reports the real launch token, but the factory says the curve is someone else.
        LyingCurve liar = new LyingCurve(launchToken, escrow);
        vm.deal(address(liar), 1 ether);
        assertFalse(escrow.isAuthorizedCrediter(address(liar)));
        vm.expectRevert(BuilderPadFeeEscrow.NotAuthorizedCrediter.selector);
        liar.creditNative{value: 1 ether}(alice);
    }

    function test_auth_unknownTokenRejected() public {
        MockCurve orphan = new MockCurve(address(0xCAFE), escrow); // not in factory
        vm.deal(address(orphan), 1 ether);
        assertFalse(escrow.isAuthorizedCrediter(address(orphan)));
        vm.expectRevert(BuilderPadFeeEscrow.NotAuthorizedCrediter.selector);
        orphan.creditNative{value: 1 ether}(alice);
    }

    function test_auth_revertingTokenGetterRejected() public {
        RevertingTokenGetter r = new RevertingTokenGetter(escrow);
        vm.deal(address(r), 1 ether);
        assertFalse(escrow.isAuthorizedCrediter(address(r)));
        vm.expectRevert(BuilderPadFeeEscrow.NotAuthorizedCrediter.selector);
        r.creditNative{value: 1 ether}(alice);
    }

    function test_auth_curveLosesAuthIfFactoryRecordChanges() public {
        factory.setCurve(launchToken, address(0x1234));
        assertFalse(escrow.isAuthorizedCrediter(address(curve)));
    }

    function test_auth_unwiredEscrowRejectsEverything() public {
        BuilderPadFeeEscrow fresh = new BuilderPadFeeEscrow(owner);
        MockCurve c = new MockCurve(launchToken, fresh);
        vm.deal(address(c), 1 ether);
        assertFalse(fresh.isAuthorizedCrediter(address(hook)));
        assertFalse(fresh.isAuthorizedCrediter(address(c)));
        vm.expectRevert(BuilderPadFeeEscrow.NotAuthorizedCrediter.selector);
        c.creditNative{value: 1 ether}(alice);
    }

    // ------------------------------------------------------------------ //
    // Native credit / claim
    // ------------------------------------------------------------------ //

    function test_credit_native_fromEachCrediter() public {
        hook.creditNative{value: 1 ether}(alice);
        vault.creditNative{value: 2 ether}(alice);
        curve.creditNative{value: 3 ether}(bob);
        assertEq(escrow.balanceOf(alice), 3 ether);
        assertEq(escrow.balanceOf(bob), 3 ether);
        assertEq(escrow.totalNative(), 6 ether);
        assertEq(address(escrow).balance, 6 ether);
    }

    function test_credit_native_zeroReverts() public {
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAmount.selector);
        hook.creditNative{value: 0}(alice);
    }

    function test_credit_native_zeroRecipientReverts() public {
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAddress.selector);
        hook.creditNative{value: 1}(address(0));
    }

    function test_claim_native_full() public {
        hook.creditNative{value: 5 ether}(alice);
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 got = escrow.claim();
        assertEq(got, 5 ether);
        assertEq(alice.balance - before, 5 ether);
        assertEq(escrow.balanceOf(alice), 0);
        assertEq(escrow.totalNative(), 0);
        assertEq(address(escrow).balance, 0);
    }

    function test_claim_native_partial() public {
        hook.creditNative{value: 5 ether}(alice);
        vm.prank(alice);
        escrow.claim(2 ether);
        assertEq(escrow.balanceOf(alice), 3 ether);
        assertEq(escrow.totalNative(), 3 ether);
        assertEq(address(escrow).balance, 3 ether);
    }

    function test_claim_native_tooMuchReverts() public {
        hook.creditNative{value: 1 ether}(alice);
        vm.prank(alice);
        vm.expectRevert(BuilderPadFeeEscrow.InsufficientBalance.selector);
        escrow.claim(1 ether + 1);
    }

    function test_claim_native_nothingOwedReverts() public {
        vm.prank(bob);
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAmount.selector);
        escrow.claim();
    }

    function test_claim_native_doesNotTouchOthers() public {
        hook.creditNative{value: 1 ether}(alice);
        hook.creditNative{value: 2 ether}(bob);
        vm.prank(alice);
        escrow.claim();
        assertEq(escrow.balanceOf(bob), 2 ether);
        assertEq(address(escrow).balance, 2 ether);
    }

    function test_claim_native_reentrancyBlocked() public {
        ReentrantClaimer r = new ReentrantClaimer(escrow);
        hook.creditNative{value: 4 ether}(address(r));
        uint256 got = r.claimAll();
        assertEq(got, 4 ether);
        assertEq(address(r).balance, 4 ether);
        assertEq(r.reentries(), 1);
        assertFalse(r.reenterSucceeded(), "re-entrant claim must fail");
        assertEq(escrow.balanceOf(address(r)), 0);
        assertEq(address(escrow).balance, 0);
    }

    function test_claim_native_rejectingRecipientOnlyBlocksItself() public {
        RejectingRecipient bad = new RejectingRecipient(escrow);
        hook.creditNative{value: 1 ether}(address(bad));
        hook.creditNative{value: 1 ether}(alice);
        vm.expectRevert(BuilderPadFeeEscrow.NativeTransferFailed.selector);
        bad.claimAll();
        // Ledger unchanged for the failed claimer; others unaffected.
        assertEq(escrow.balanceOf(address(bad)), 1 ether);
        vm.prank(alice);
        assertEq(escrow.claim(), 1 ether);
    }

    // ------------------------------------------------------------------ //
    // ERC-20 credit / claim
    // ------------------------------------------------------------------ //

    function test_credit_token() public {
        usd.mint(address(hook), 1_000e6);
        hook.creditToken(alice, address(usd), 600e6);
        hook.creditToken(bob, address(usd), 400e6);
        assertEq(escrow.balanceOfToken(alice, address(usd)), 600e6);
        assertEq(escrow.balanceOfToken(bob, address(usd)), 400e6);
        assertEq(escrow.totalToken(address(usd)), 1_000e6);
        assertEq(usd.balanceOf(address(escrow)), 1_000e6);
    }

    function test_credit_token_requiresAuth() public {
        usd.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usd.approve(address(escrow), 100e6);
        vm.expectRevert(BuilderPadFeeEscrow.NotAuthorizedCrediter.selector);
        escrow.creditToken(alice, address(usd), 100e6);
        vm.stopPrank();
    }

    function test_credit_token_zeroReverts() public {
        // Call as the authorized hook directly so the escrow's own checks are what revert.
        vm.startPrank(address(hook));
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAmount.selector);
        escrow.creditToken(alice, address(usd), 0);
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAddress.selector);
        escrow.creditToken(alice, address(0), 1);
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAddress.selector);
        escrow.creditToken(address(0), address(usd), 1);
        vm.stopPrank();
    }

    function test_credit_token_insufficientAllowanceReverts() public {
        // MockCrediter approves exactly `amount`; ask it to credit more than it holds.
        usd.mint(address(hook), 1e6);
        vm.expectRevert();
        hook.creditToken(alice, address(usd), 2e6);
    }

    function test_credit_token_feeOnTransfer_creditsReceived() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20(100); // 1% burn
        fot.mint(address(hook), 1_000 ether);
        hook.creditToken(alice, address(fot), 1_000 ether);
        uint256 received = fot.balanceOf(address(escrow));
        assertEq(received, 990 ether);
        assertEq(escrow.balanceOfToken(alice, address(fot)), received);
        assertEq(escrow.totalToken(address(fot)), received);
    }

    function test_claim_token_full_and_partial() public {
        usd.mint(address(vault), 500e6);
        vault.creditToken(alice, address(usd), 500e6);
        vm.startPrank(alice);
        escrow.claimToken(address(usd), 100e6);
        assertEq(usd.balanceOf(alice), 100e6);
        assertEq(escrow.balanceOfToken(alice, address(usd)), 400e6);
        uint256 got = escrow.claimToken(address(usd));
        vm.stopPrank();
        assertEq(got, 400e6);
        assertEq(usd.balanceOf(alice), 500e6);
        assertEq(escrow.totalToken(address(usd)), 0);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    function test_claim_token_tooMuchReverts() public {
        usd.mint(address(vault), 1e6);
        vault.creditToken(alice, address(usd), 1e6);
        vm.prank(alice);
        vm.expectRevert(BuilderPadFeeEscrow.InsufficientBalance.selector);
        escrow.claimToken(address(usd), 1e6 + 1);
    }

    function test_claim_token_nothingOwedReverts() public {
        vm.prank(alice);
        vm.expectRevert(BuilderPadFeeEscrow.ZeroAmount.selector);
        escrow.claimToken(address(usd));
    }

    function test_ledgers_areIndependent() public {
        usd.mint(address(hook), 10e6);
        hook.creditNative{value: 1 ether}(alice);
        hook.creditToken(alice, address(usd), 10e6);
        vm.prank(alice);
        escrow.claim();
        assertEq(escrow.balanceOfToken(alice, address(usd)), 10e6);
        assertEq(escrow.balanceOf(alice), 0);
    }

    // ------------------------------------------------------------------ //
    // Surface: nothing else
    // ------------------------------------------------------------------ //

    function test_noStrayEthAccepted() public {
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertFalse(ok, "escrow must not accept plain ETH");
    }

    // ------------------------------------------------------------------ //
    // Fuzz: conservation on random sequences
    // ------------------------------------------------------------------ //

    function testFuzz_native_conservation(uint96 a, uint96 b, uint96 claimA) public {
        vm.assume(a > 0 && b > 0);
        vm.deal(address(this), uint256(a) + uint256(b));
        hook.creditNative{value: a}(alice);
        hook.creditNative{value: b}(bob);
        uint256 c = bound(claimA, 1, a);
        vm.prank(alice);
        escrow.claim(c);
        assertEq(escrow.totalNative(), uint256(a) + uint256(b) - c);
        assertEq(address(escrow).balance, escrow.totalNative());
        assertEq(escrow.balanceOf(alice) + escrow.balanceOf(bob), escrow.totalNative());
    }
}
