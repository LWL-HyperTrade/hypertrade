// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title Config
 * @notice Every number and address the fork deployment depends on, in one
 * place. The Solidity sources are vendored verbatim from the live Pons v2
 * deployment; all economic differences from Pons live here and are applied
 * through constructor arguments, owner setters and the launch config.
 *
 * See docs/PONS_FORK.md for the rationale and the live-Pons baseline each
 * value was diffed against.
 */
library Config {
    // ------------------------------------------------------------------ //
    // Chain
    // ------------------------------------------------------------------ //
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;

    // Uniswap v4 (official, from developers.uniswap.org/docs/protocols/v4/deployments)
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ------------------------------------------------------------------ //
    // Protocol identity
    // ------------------------------------------------------------------ //
    /// Builder wallet — receives the protocol fee share and the launch fee.
    address internal constant PROTOCOL_FEE_RECIPIENT = 0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB;

    // ------------------------------------------------------------------ //
    // Economics (targets) — all in basis points unless stated
    // ------------------------------------------------------------------ //
    uint256 internal constant BASIS_POINTS = 10_000;

    /// Paid by creators on each launch, as msg.value. Pons: 0.0005 ether.
    uint256 internal constant LAUNCH_FEE = 0.00025 ether;

    /// Curve base trade fee on the quote leg. Pons: 100.
    uint256 internal constant CURVE_FEE_BPS = 75;

    /// Post-graduation hook fee on the unspecified currency of each swap. Pons: 100.
    uint256 internal constant HOOK_FEE_BPS = 75;

    /// Protocol's slice of every fee (curve and hook). Creator gets the rest. Pons: 3000.
    uint256 internal constant PROTOCOL_FEE_SHARE_BPS = 1_000; // 10% protocol / 90% creator

    /// When a launch has buyback enabled: slice of the *creator* bucket
    /// diverted to buy-and-lock. Pons: 5000.
    uint256 internal constant BUYBACK_BURN_BPS = 2_500; // 25% of the creator 90%

    /// Ceiling on creator-chosen trade tax. Pons: 1000 (contract max is 1000).
    uint256 internal constant MAX_CREATOR_TAX_BPS = 1_000;

    /// Anti-snipe: matches the *live* Pons factory (source default is 15 s).
    uint256 internal constant SNIPE_TAX_START_BPS = 9_900;
    uint256 internal constant SNIPE_TAX_SECONDS = 3;

    /// Hook internal buyback conversion price-impact bound. Matches live Pons.
    uint256 internal constant MAX_INTERNAL_PRICE_IMPACT_BPS = 300;

    // ------------------------------------------------------------------ //
    // Launch config 0 — identical to live Pons config 0 except curveFeeBps
    // ------------------------------------------------------------------ //
    uint256 internal constant LAUNCH_SUPPLY = 1_000_000_000 ether; // 1e9 * 1e18
    uint256 internal constant NATIVE_PHANTOM_QUOTE = 1.68 ether;
    uint256 internal constant NATIVE_GRADUATION_THRESHOLD = 4.2 ether;
    uint24 internal constant POOL_FEE = 0; // all fees via the hook
    int24 internal constant TICK_SPACING = 200;

    // ------------------------------------------------------------------ //
    // Uniswap v4 hook address flags (Hooks.sol)
    // ------------------------------------------------------------------ //
    uint160 internal constant HOOK_FLAGS = uint160(
        (1 << 13) // BEFORE_INITIALIZE_FLAG
            | (1 << 6) // AFTER_SWAP_FLAG
            | (1 << 2) // AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    // ------------------------------------------------------------------ //
    // Approved ERC-20 quote assets — copied from live Pons pairTokenEconomics
    // (2026-09-13). Base units at the token's decimals. Ratio phantom:threshold = 0.4.
    // ------------------------------------------------------------------ //
    struct PairToken {
        string symbol;
        address token;
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint8 decimals;
    }

    function pairTokens() internal pure returns (PairToken[] memory list) {
        list = new PairToken[](17);
        list[0] = PairToken("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 16640000000000000000, 41600000000000000000, 18);
        list[1] = PairToken("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 10400000000000000000, 26000000000000000000, 18);
        list[2] = PairToken("AAPL", 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 9680000000000000000, 24200000000000000000, 18);
        list[3] = PairToken("MSFT", 0xe93237C50D904957Cf27E7B1133b510C669c2e74, 6431455767077268559, 16078639417693171399, 18);
        list[4] = PairToken("AMZN", 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 11732116436857081003, 29330291092142702509, 18);
        list[5] = PairToken("GOOGL", 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 9680000000000000000, 24200000000000000000, 18);
        list[6] = PairToken("META", 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 5427158043940468620, 13567895109851171552, 18);
        list[7] = PairToken("SPY", 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 4360000000000000000, 10900000000000000000, 18);
        list[8] = PairToken("COIN", 0x6330D8C3178a418788dF01a47479c0ce7CCF450b, 20988269381362569995, 52470673453406424989, 18);
        list[9] = PairToken("MSTR", 0xec262a75e413fAfD0dF80480274532C79D42da09, 31992090954028668648, 79980227385071671620, 18);
        list[10] = PairToken("AMD", 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 6666201836383609007, 16665504590959022517, 18);
        list[11] = PairToken("NFLX", 0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8, 52121218543046357757, 130303046357615894393, 18);
        list[12] = PairToken("PLTR", 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A, 18826050105361742750, 47065125263404356876, 18);
        list[13] = PairToken("GME", 0x1b0E319c6A659F002271B69dB8A7df2F911c153E, 147600000000000000000, 369000000000000000000, 18);
        list[14] = PairToken("AMC", 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B, 1536025873605948496516, 3840064684014871241292, 18);
        list[15] = PairToken("SPCX", 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 28880000000000000000, 72200000000000000000, 18);
        list[16] = PairToken("USDG", 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, 3236000000, 8090000000, 6);
    }
}
