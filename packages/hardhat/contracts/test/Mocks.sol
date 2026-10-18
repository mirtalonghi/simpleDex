// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Token que cobra 1 % en cada transferencia (para probar "fee-on-transfer").
contract FeeToken is ERC20 {
    constructor() ERC20("FeeToken", "FEE") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Token mal hecho: transferFrom devuelve false en vez de revertir cuando no hay allowance.
contract FalseReturnToken is ERC20 {
    constructor() ERC20("FalseToken", "FLS") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (allowance(from, msg.sender) < value || balanceOf(from) < value) return false;
        return super.transferFrom(from, to, value);
    }
}
