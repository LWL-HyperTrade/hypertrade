// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BuilderPadFeeEscrow} from "../src/BuilderPadFeeEscrow.sol";
import {MockERC20, MockFactory, MockCurve, MockCrediter} from "./mocks/Mocks.sol";

/**
 * @notice Randomised credits (from every authorized source) and claims (by
 * random recipients, full and partial) plus adversarial calls. Invariants:
 * ledger sums equal holdings, nobody ever claims more than credited.
 */
contract EscrowHandler is Test {
    BuilderPadFeeEscrow public escrow;
    MockCrediter public hook;
    MockCrediter public vault;
    MockCurve public curve;
    MockERC20[] public tokens;
    address[] public actors;

    // ghost accounting
    uint256 public ghostNativeCredited;
    uint256 public ghostNativeClaimed;
    mapping(address token => uint256) public ghostTokenCredited;
    mapping(address token => uint256) public ghostTokenClaimed;
    mapping(address actor => uint256) public ghostNativeOf;
    mapping(address actor => mapping(address token => uint256)) public ghostTokenOf;
    uint256 public unauthorizedAttempts;
    uint256 public unauthorizedSuccesses;

    constructor(BuilderPadFeeEscrow e, MockCrediter h, MockCrediter v, MockCurve c, MockERC20[] memory t) {
        escrow = e;
        hook = h;
        vault = v;
        curve = c;
        tokens = t;
        for (uint256 i = 0; i < 6; i++) {
            actors.push(address(uint160(uint256(keccak256(abi.encode("actor", i))))));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (MockERC20) {
        return tokens[seed % tokens.length];
    }

    function creditNative(uint256 who, uint256 src, uint96 amount) external {
        amount = uint96(bound(amount, 1, 50 ether));
        address to = _actor(who);
        uint256 s = src % 3;
        if (s == 0) {
            vm.deal(address(hook), amount);
            hook.creditNative{value: amount}(to);
        } else if (s == 1) {
            vm.deal(address(vault), amount);
            vault.creditNative{value: amount}(to);
        } else {
            vm.deal(address(curve), amount);
            curve.creditNative{value: amount}(to);
        }
        ghostNativeCredited += amount;
        ghostNativeOf[to] += amount;
    }

    function creditToken(uint256 who, uint256 src, uint256 tok, uint96 amount) external {
        amount = uint96(bound(amount, 1, 1_000_000e18));
        address to = _actor(who);
        MockERC20 t = _token(tok);
        uint256 s = src % 3;
        address from = s == 0 ? address(hook) : s == 1 ? address(vault) : address(curve);
        t.mint(from, amount);
        if (s == 0) hook.creditToken(to, address(t), amount);
        else if (s == 1) vault.creditToken(to, address(t), amount);
        else curve.creditToken(to, address(t), amount);
        ghostTokenCredited[address(t)] += amount;
        ghostTokenOf[to][address(t)] += amount;
    }

    function claimNativeAll(uint256 who) external {
        address a = _actor(who);
        uint256 owed = escrow.balanceOf(a);
        if (owed == 0) return;
        vm.prank(a);
        uint256 got = escrow.claim();
        ghostNativeClaimed += got;
        ghostNativeOf[a] -= got;
    }

    function claimNativePartial(uint256 who, uint256 part) external {
        address a = _actor(who);
        uint256 owed = escrow.balanceOf(a);
        if (owed == 0) return;
        uint256 amt = bound(part, 1, owed);
        vm.prank(a);
        escrow.claim(amt);
        ghostNativeClaimed += amt;
        ghostNativeOf[a] -= amt;
    }

    function claimTokenAll(uint256 who, uint256 tok) external {
        address a = _actor(who);
        MockERC20 t = _token(tok);
        uint256 owed = escrow.balanceOfToken(a, address(t));
        if (owed == 0) return;
        vm.prank(a);
        uint256 got = escrow.claimToken(address(t));
        ghostTokenClaimed[address(t)] += got;
        ghostTokenOf[a][address(t)] -= got;
    }

    function claimTokenPartial(uint256 who, uint256 tok, uint256 part) external {
        address a = _actor(who);
        MockERC20 t = _token(tok);
        uint256 owed = escrow.balanceOfToken(a, address(t));
        if (owed == 0) return;
        uint256 amt = bound(part, 1, owed);
        vm.prank(a);
        escrow.claimToken(address(t), amt);
        ghostTokenClaimed[address(t)] += amt;
        ghostTokenOf[a][address(t)] -= amt;
    }

    /// Adversarial: over-claim must always revert.
    function overClaim(uint256 who, uint256 extra) external {
        address a = _actor(who);
        uint256 owed = escrow.balanceOf(a);
        uint256 amt = owed + bound(extra, 1, 1 ether);
        vm.prank(a);
        try escrow.claim(amt) {
            unauthorizedSuccesses++;
        } catch {}
        unauthorizedAttempts++;
    }

    /// Adversarial: random EOA credits must always revert.
    function unauthorizedCredit(uint256 who, uint96 amount) external {
        address a = _actor(who);
        amount = uint96(bound(amount, 1, 1 ether));
        vm.deal(a, amount);
        vm.prank(a);
        try escrow.credit{value: amount}(a) {
            unauthorizedSuccesses++;
        } catch {}
        unauthorizedAttempts++;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }
}

contract FeeEscrowInvariantTest is Test {
    BuilderPadFeeEscrow escrow;
    EscrowHandler handler;
    MockERC20[] tokens;

    address owner = makeAddr("owner");
    address launchToken = address(0xBEEF);

    function setUp() public {
        escrow = new BuilderPadFeeEscrow(owner);
        MockFactory factory = new MockFactory();
        MockCrediter hook = new MockCrediter(escrow);
        MockCrediter vault = new MockCrediter(escrow);
        MockCurve curve = new MockCurve(launchToken, escrow);
        factory.setCurve(launchToken, address(curve));
        vm.startPrank(owner);
        escrow.setFactory(address(factory));
        escrow.setHook(address(hook));
        escrow.setBuybackVault(address(vault));
        vm.stopPrank();

        tokens.push(new MockERC20("A", "A", 18));
        tokens.push(new MockERC20("B", "B", 6));
        tokens.push(new MockERC20("C", "C", 8));

        handler = new EscrowHandler(escrow, hook, vault, curve, tokens);
        targetContract(address(handler));
        // The fuzzer picks `msg.sender` from every known address and pre-funds it
        // for gas. If it picks the escrow itself, `address(escrow).balance` moves
        // with no credit — impossible on-chain (no receive / selfdestruct path),
        // so keep those addresses out of the sender set.
        excludeSender(address(escrow));
        excludeSender(address(hook));
        excludeSender(address(vault));
        excludeSender(address(curve));
        for (uint256 i = 0; i < tokens.length; i++) excludeSender(address(tokens[i]));
    }

    /// ETH held == total owed == Σ per-recipient owed; nothing leaks in or out.
    function invariant_nativeConservation() public view {
        assertEq(address(escrow).balance, escrow.totalNative(), "eth balance != totalNative");
        assertEq(
            escrow.totalNative(),
            handler.ghostNativeCredited() - handler.ghostNativeClaimed(),
            "totalNative != credited - claimed"
        );
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            assertEq(escrow.balanceOf(a), handler.ghostNativeOf(a), "per-actor native mismatch");
            sum += escrow.balanceOf(a);
        }
        assertEq(sum, escrow.totalNative(), "sum of native balances != totalNative");
    }

    /// Per token: held == total owed == Σ per-recipient owed.
    function invariant_tokenConservation() public view {
        for (uint256 t = 0; t < handler.tokenCount(); t++) {
            MockERC20 tok = handler.tokens(t);
            assertEq(tok.balanceOf(address(escrow)), escrow.totalToken(address(tok)), "token balance != totalToken");
            assertEq(
                escrow.totalToken(address(tok)),
                handler.ghostTokenCredited(address(tok)) - handler.ghostTokenClaimed(address(tok)),
                "totalToken != credited - claimed"
            );
            uint256 sum;
            for (uint256 i = 0; i < handler.actorCount(); i++) {
                address a = handler.actors(i);
                assertEq(escrow.balanceOfToken(a, address(tok)), handler.ghostTokenOf(a, address(tok)));
                sum += escrow.balanceOfToken(a, address(tok));
            }
            assertEq(sum, escrow.totalToken(address(tok)), "sum of token balances != totalToken");
        }
    }

    /// No over-claim or unauthorized credit ever succeeds.
    function invariant_noUnauthorizedSuccess() public view {
        assertEq(handler.unauthorizedSuccesses(), 0, "an unauthorized operation succeeded");
    }

    /// Nobody can have claimed more than was ever credited.
    function invariant_claimedNeverExceedsCredited() public view {
        assertLe(handler.ghostNativeClaimed(), handler.ghostNativeCredited());
        for (uint256 t = 0; t < handler.tokenCount(); t++) {
            address tok = address(handler.tokens(t));
            assertLe(handler.ghostTokenClaimed(tok), handler.ghostTokenCredited(tok));
        }
    }
}
