// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract MockCreditPoolForMcpPoc {
    address public immutable usdg;
    constructor(address token) { usdg = token; }
}
