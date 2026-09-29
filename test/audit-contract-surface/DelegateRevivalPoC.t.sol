// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CreditPoolV2Base} from "../CreditPoolV2.t.sol";
import {CreditPoolV2} from "../../src/CreditPoolV2.sol";

/// Regression PoC: a delegate invalidated by an NFT transfer becomes a controller again
/// if the original owner later reacquires the same agent NFT.
contract DelegateRevivalPoCTest is CreditPoolV2Base {
    function test_delegateRevivesAfterOwnerReacquiresAgent() public {
        _sponsor(ROOT, rootOwner, AGENT, AGENT_PK, 10 * USDC);

        address hot = makeAddr("old-delegate");

        vm.prank(agentOwner);
        pool.setDelegate(AGENT, hot);

        vm.prank(agentOwner);
        reg.transferFrom(agentOwner, anyone, AGENT);
        vm.prank(hot);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotController.selector, AGENT, hot));
        pool.borrow(AGENT, 5 * USDC, 7 days, hot, type(uint256).max);

        vm.prank(anyone);
        reg.transferFrom(anyone, agentOwner, AGENT);

        assertTrue(pool.isController(AGENT, hot), "stale delegate unexpectedly reactivated");

        vm.prank(hot);
        uint256 loan = pool.borrow(AGENT, 5 * USDC, 7 days, hot, type(uint256).max);

        vm.warp(pool.getLoan(loan).defaultableAt + 1);
        uint256 backingBefore = pool.backing(ROOT);
        vm.prank(keeper);
        pool.markDefault(loan);

        assertLt(pool.backing(ROOT), backingBefore, "stale delegate caused no backer loss");
    }
}
