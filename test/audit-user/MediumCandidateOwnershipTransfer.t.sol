// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TreasuryV4Base} from "../TreasurySponsorV4.t.sol";
import {CreditPoolV2} from "../../src/CreditPoolV2.sol";

/// @dev Candidate validation for the NFT-transfer + treasury-raise compound path.
/// This is deliberately on a fork-only test branch and uses the existing mock registry.
contract MediumCandidateOwnershipTransferTest is TreasuryV4Base {
    uint256 constant MALLORY_PK = 0xBAD;
    address mallory = vm.addr(MALLORY_PK);

    function test_candidate_raiseAndBorrowSurvivesNftTransfer() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);

        assertTrue(treasury.eligibleForRaise(AGENT));
        assertEq(_line(AGENT), 5 * USDC);

        // The original owner sells/transfers the ERC-8004 identity.
        vm.prank(agentOp);
        reg.transferFrom(agentOp, mallory, AGENT);

        // The new owner was not the original owner who established the treasury line.
        assertEq(reg.ownerOf(AGENT), mallory);
        assertTrue(treasury.eligibleForRaise(AGENT));

        // No new owner consent is requested by raise(); the treasury adds its second-line backing.
        vm.prank(anyone);
        treasury.raise(AGENT);
        assertEq(_line(AGENT), 50 * USDC);

        // The buyer can now draw the raised line and leave the original treasury bearing the loss.
        uint256 treasuryBefore = pool.backing(TREASURY_ID);
        uint256 loan = _borrow(mallory, AGENT, 50 * USDC, 30 days);
        assertEq(pool.getLoan(loan).owner, mallory);

        vm.prank(mallory);
        usdc.transfer(anyone, 50 * USDC);
        _default(loan);

        assertLt(pool.backing(TREASURY_ID), treasuryBefore);
        assertEq(usdc.balanceOf(mallory), 0);
        assertEq(pool.getLoan(loan).status, CreditPoolV2.LoanStatus.Defaulted);
    }
}
