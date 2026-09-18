// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Config} from "./Config.sol";
import {StackDeployer} from "./StackDeployer.sol";

/**
 * @title Deploy
 * @notice Deploys the 9-contract Pons v2 fork stack and wires it with the
 * economics in `Config`. Owner == broadcaster for this run (every wiring call
 * is `onlyOwner`); hand ownership to a multisig afterwards via Ownable2Step.
 *
 * Usage (never put a private key in a file — use a keystore account).
 * Default RPC is `robinhood` = `ROBINHOOD_RPC_URL` in contracts/pons-v2/.env.
 * Fallback if that var is unset: `--rpc-url robinhood_public`.
 *   forge script script/Deploy.s.sol:Deploy --rpc-url robinhood \
 *     --account <keystore-name> --sender <address> --broadcast \
 *     --verify --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
 *
 * Dry run (omit --broadcast) simulates everything, including the asserts.
 */
contract Deploy is Script, StackDeployer {
    // Forge's default deterministic CREATE2 deployer (present on 4663 and 46630).
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        uint256 chainId = block.chainid;
        require(
            chainId == Config.ROBINHOOD_CHAIN_ID || chainId == Config.ROBINHOOD_TESTNET_CHAIN_ID,
            "Deploy: unexpected chain"
        );

        Externals memory x = Externals({
            poolManager: vm.envOr("POOL_MANAGER", Config.POOL_MANAGER),
            positionManager: vm.envOr("POSITION_MANAGER", Config.POSITION_MANAGER),
            permit2: vm.envOr("PERMIT2", Config.PERMIT2),
            protocolFeeRecipient: vm.envOr("PROTOCOL_FEE_RECIPIENT", Config.PROTOCOL_FEE_RECIPIENT),
            create2Deployer: CREATE2_DEPLOYER
        });
        require(x.poolManager.code.length > 0, "Deploy: PoolManager has no code on this chain");
        require(x.positionManager.code.length > 0, "Deploy: PositionManager has no code on this chain");
        require(x.permit2.code.length > 0, "Deploy: Permit2 has no code on this chain");
        require(x.create2Deployer.code.length > 0, "Deploy: CREATE2 deployer missing");

        bool mainnet = chainId == Config.ROBINHOOD_CHAIN_ID;

        vm.startBroadcast();
        address owner = msg.sender;
        console2.log("chain", chainId);
        console2.log("owner/deployer", owner);
        console2.log("protocol fee recipient", x.protocolFeeRecipient);

        Stack memory s = deployStack(owner, x, true);
        wireStack(s, mainnet, true);
        vm.stopBroadcast();

        assertStack(s, x.protocolFeeRecipient, mainnet);
        console2.log("config asserts: OK");
        _writeJson(s, chainId, owner, x);
    }

    function _writeJson(Stack memory s, uint256 chainId, address owner, Externals memory x) internal {
        string memory j = "deployment";
        vm.serializeUint(j, "chainId", chainId);
        vm.serializeAddress(j, "owner", owner);
        vm.serializeAddress(j, "protocolFeeRecipient", x.protocolFeeRecipient);
        vm.serializeAddress(j, "poolManager", x.poolManager);
        vm.serializeAddress(j, "positionManager", x.positionManager);
        vm.serializeAddress(j, "permit2", x.permit2);
        vm.serializeAddress(j, "factory", address(s.factory));
        vm.serializeAddress(j, "memeHook", address(s.hook));
        vm.serializeAddress(j, "feeEscrow", address(s.escrow));
        vm.serializeAddress(j, "buybackVault", address(s.vault));
        vm.serializeAddress(j, "launchLocker", address(s.locker));
        vm.serializeAddress(j, "launchAndBuy", address(s.launchAndBuy));
        vm.serializeAddress(j, "launchDeployer", address(s.deployer));
        vm.serializeAddress(j, "graduationExecutor", address(s.executor));
        string memory out = vm.serializeAddress(j, "graduationGuard", s.guard);
        string memory path = string.concat("./deployments/", vm.toString(chainId), ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
