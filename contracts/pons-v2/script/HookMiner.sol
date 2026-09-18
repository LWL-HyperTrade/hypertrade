// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title HookMiner
 * @notice Finds a CREATE2 salt such that the deployed hook's address encodes
 * the required Uniswap v4 permission flags in its low 14 bits. Same approach
 * as Uniswap's `v4-periphery/src/utils/HookMiner.sol`, kept local so the
 * vendored periphery subset stays untouched.
 */
library HookMiner {
    uint160 internal constant FLAG_MASK = uint160((1 << 14) - 1);
    uint256 internal constant MAX_LOOP = 200_000;

    /// @param deployer The CREATE2 deployer (forge scripts use 0x4e59b44847b379578588920cA78FbF26c0B4956C).
    /// @param flags Required permission bits.
    /// @param creationCode `type(Hook).creationCode`.
    /// @param constructorArgs `abi.encode(...)` of the hook constructor arguments.
    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        flags = flags & FLAG_MASK;
        bytes memory initcode = abi.encodePacked(creationCode, constructorArgs);
        bytes32 initHash = keccak256(initcode);
        for (uint256 i = 0; i < MAX_LOOP; i++) {
            salt = bytes32(i);
            hookAddress = computeAddress(deployer, salt, initHash);
            if (uint160(hookAddress) & FLAG_MASK == flags && hookAddress.code.length == 0) {
                return (hookAddress, salt);
            }
        }
        revert("HookMiner: could not find salt");
    }

    function computeAddress(address deployer, bytes32 salt, bytes32 initHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash)))));
    }
}
