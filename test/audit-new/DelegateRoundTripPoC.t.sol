// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../CreditPoolV2.t.sol";

/// Regression PoC for a stale delegate authorization surviving an NFT ownership round-trip.
contract DelegateRoundTripPoC is CreditPoolV2Base {
    function test_staleDelegateRevivesAfterOwnershipRoundTrip() public {
        _sponsor(ROOT, rootOwner, AGENT, AGENT_PK, 10 * USDC);

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

        // A later transfer back to the original owner resurrects the old delegate,
        // even though the NFT changed hands in between.
        vm.prank(agent2Owner);
        reg.transferFrom(agent2Owner, agentOwner, AGENT);
        assertEq(reg.ownerOf(AGENT), agentOwner);
        assertTrue(pool.isController(AGENT, hot));

        // The stale delegate can now move backed credit to itself without a new
        // authorization from the current owner.
        vm.prank(hot);
        uint256 loanId = pool.borrow(AGENT, 5 * USDC, 1 days, hot, type(uint256).max);

        assertEq(pool.getLoan(loanId).owner, agentOwner);
        assertEq(usdc.balanceOf(hot), 5 * USDC);
    }
}
