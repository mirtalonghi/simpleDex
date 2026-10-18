const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));

async function deploy(dexName = "SimpleDEX") {
  const [owner, alice, bob, attacker] = await ethers.getSigners();
  const tokenA = await (await ethers.getContractFactory("TokenA")).deploy();
  const tokenB = await (await ethers.getContractFactory("TokenB")).deploy();
  const dex = await (await ethers.getContractFactory(dexName)).deploy(await tokenA.getAddress(), await tokenB.getAddress());
  const dexAddr = await dex.getAddress();
  for (const u of [alice, bob, attacker]) {
    await tokenA.mint(u.address, E(10_000));
    await tokenB.mint(u.address, E(10_000));
  }
  for (const u of [owner, alice, bob, attacker]) {
    await tokenA.connect(u).approve(dexAddr, ethers.MaxUint256);
    await tokenB.connect(u).approve(dexAddr, ethers.MaxUint256);
  }
  return { owner, alice, bob, attacker, tokenA, tokenB, dex, dexAddr };
}

describe("SimpleDEX v1 (original) — fallas demostradas", function () {
  it("swap con el pool vacío: el usuario entrega tokens y no recibe nada", async function () {
    const { alice, tokenA, dex } = await deploy("SimpleDEXOriginal");
    const before = await tokenA.balanceOf(alice.address);
    await dex.connect(alice).swapAforB(E(10));
    expect(await tokenA.balanceOf(alice.address)).to.equal(before - E(10)); // perdió 10 A
  });

  it("donación: enviar tokens directo al contrato cambia el precio", async function () {
    const { owner, attacker, tokenA, tokenB, dex, dexAddr } = await deploy("SimpleDEXOriginal");
    await dex.connect(owner).addLiquidity(E(100), E(100));
    const p0 = await dex.getPrice(await tokenA.getAddress());
    await tokenB.connect(attacker).transfer(dexAddr, E(100)); // "regalo" sin pasar por el DEX
    const p1 = await dex.getPrice(await tokenA.getAddress());
    expect(p1).to.equal(p0 * 2n);
  });

  it("sandwich: sin mínimo a recibir, la víctima recibe mucho menos", async function () {
    const { owner, alice, attacker, tokenB, dex } = await deploy("SimpleDEXOriginal");
    await dex.connect(owner).addLiquidity(E(1000), E(1000));
    const b0 = await tokenB.balanceOf(alice.address);
    await dex.connect(attacker).swapAforB(E(500)); // front-run
    await dex.connect(alice).swapAforB(E(100));
    const got = (await tokenB.balanceOf(alice.address)) - b0;
    // Sin el ataque habría recibido ~90,9 B; con el ataque recibe ~41,7 B y la transacción no revierte.
    expect(got).to.be.lt(E(42));
  });

  it("getPrice con el pool vacío falla con un error de división por cero", async function () {
    const { tokenA, dex } = await deploy("SimpleDEXOriginal");
    await expect(dex.getPrice(await tokenA.getAddress())).to.be.revertedWithPanic(0x12);
  });
});

describe("SimpleDEX v2 (mejorado)", function () {
  describe("constructor", function () {
    it("rechaza la dirección cero y el mismo token dos veces", async function () {
      const F = await ethers.getContractFactory("SimpleDEX");
      const t = await (await ethers.getContractFactory("TokenA")).deploy();
      const a = await t.getAddress();
      await expect(F.deploy(ethers.ZeroAddress, a)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(a, a)).to.be.revertedWithCustomError(F, "SameToken");
    });
  });

  describe("pool vacío", function () {
    it("no permite swaps y el usuario conserva sus tokens", async function () {
      const { alice, tokenA, dex } = await deploy();
      const before = await tokenA.balanceOf(alice.address);
      await expect(dex.connect(alice).swapAforB(E(10), 0)).to.be.revertedWithCustomError(dex, "EmptyPool");
      expect(await tokenA.balanceOf(alice.address)).to.equal(before);
    });

    it("getPrice devuelve un error claro", async function () {
      const { tokenA, dex } = await deploy();
      await expect(dex.getPrice(await tokenA.getAddress())).to.be.revertedWithCustomError(dex, "EmptyPool");
    });
  });

  describe("liquidez", function () {
    it("solo el owner puede agregar o retirar", async function () {
      const { alice, dex } = await deploy();
      await expect(dex.connect(alice).addLiquidity(E(1), E(1))).to.be.revertedWithCustomError(dex, "OwnableUnauthorizedAccount");
      await expect(dex.connect(alice).removeLiquidity(E(1), E(1))).to.be.revertedWithCustomError(dex, "OwnableUnauthorizedAccount");
    });

    it("la primera carga fija el precio y actualiza reservas", async function () {
      const { owner, tokenA, dex } = await deploy();
      await expect(dex.addLiquidity(E(100), E(200))).to.emit(dex, "LiquidityAdded").withArgs(owner.address, E(100), E(200));
      expect(await dex.reserveA()).to.equal(E(100));
      expect(await dex.reserveB()).to.equal(E(200));
      expect(await dex.getPrice(await tokenA.getAddress())).to.equal(E(2));
    });

    it("las cargas siguientes respetan la proporción y no mueven el precio", async function () {
      const { tokenA, dex } = await deploy();
      await dex.addLiquidity(E(100), E(200));
      await dex.addLiquidity(E(50), E(500)); // sobra B: toma solo 100 B
      expect(await dex.reserveA()).to.equal(E(150));
      expect(await dex.reserveB()).to.equal(E(300));
      expect(await dex.getPrice(await tokenA.getAddress())).to.equal(E(2));
    });

    it("no deja un lado del pool vacío y el otro con fondos", async function () {
      const { dex } = await deploy();
      await dex.addLiquidity(E(100), E(100));
      await expect(dex.removeLiquidity(E(100), E(10))).to.be.revertedWithCustomError(dex, "UnbalancedRemoval");
      await expect(dex.removeLiquidity(E(101), E(1))).to.be.revertedWithCustomError(dex, "InsufficientLiquidity");
      await dex.removeLiquidity(E(100), E(100)); // vaciar ambos sí se puede
      expect(await dex.reserveA()).to.equal(0);
    });
  });

  describe("swaps", function () {
    it("cobra 0,3 % y respeta la fórmula x*y=k", async function () {
      const { alice, tokenA, tokenB, dex } = await deploy();
      await dex.addLiquidity(E(1000), E(1000));
      const quote = await dex.getAmountOut(await tokenA.getAddress(), E(100));
      const inFee = E(100) * 9970n;
      expect(quote).to.equal((inFee * E(1000)) / (E(1000) * 10000n + inFee));
      const b0 = await tokenB.balanceOf(alice.address);
      await expect(dex.connect(alice).swapAforB(E(100), quote))
        .to.emit(dex, "TokenSwapped")
        .withArgs(alice.address, await tokenA.getAddress(), E(100), quote);
      expect((await tokenB.balanceOf(alice.address)) - b0).to.equal(quote);
      // k no baja: la comisión queda en el pool
      expect((await dex.reserveA()) * (await dex.reserveB())).to.be.gte(E(1000) * E(1000));
    });

    it("swap B por A funciona igual", async function () {
      const { alice, tokenA, tokenB, dex } = await deploy();
      await dex.addLiquidity(E(1000), E(1000));
      const quote = await dex.getAmountOut(await tokenB.getAddress(), E(50));
      const a0 = await tokenA.balanceOf(alice.address);
      await dex.connect(alice).swapBforA(E(50), quote);
      expect((await tokenA.balanceOf(alice.address)) - a0).to.equal(quote);
    });

    it("sandwich: si el precio se movió, la víctima no opera (revierte)", async function () {
      const { alice, attacker, tokenA, dex } = await deploy();
      await dex.addLiquidity(E(1000), E(1000));
      const quote = await dex.getAmountOut(await tokenA.getAddress(), E(100));
      const minOut = (quote * 99n) / 100n; // tolera 1 % de deslizamiento
      await dex.connect(attacker).swapAforB(E(500), 0); // front-run
      await expect(dex.connect(alice).swapAforB(E(100), minOut)).to.be.revertedWithCustomError(dex, "InsufficientOutput");
    });

    it("donación: enviar tokens directo NO cambia el precio, y el owner puede recuperarlos", async function () {
      const { owner, attacker, tokenA, tokenB, dex, dexAddr } = await deploy();
      await dex.addLiquidity(E(100), E(100));
      const p0 = await dex.getPrice(await tokenA.getAddress());
      await tokenB.connect(attacker).transfer(dexAddr, E(100));
      expect(await dex.getPrice(await tokenA.getAddress())).to.equal(p0);
      await expect(dex.skim(owner.address)).to.emit(dex, "Skimmed").withArgs(owner.address, 0, E(100));
    });

    it("rechaza montos cero y tokens ajenos al pool", async function () {
      const { alice, dex } = await deploy();
      await dex.addLiquidity(E(100), E(100));
      await expect(dex.connect(alice).swapAforB(0, 0)).to.be.revertedWithCustomError(dex, "ZeroAmount");
      await expect(dex.getPrice(alice.address)).to.be.revertedWithCustomError(dex, "InvalidToken");
      await expect(dex.getAmountOut(alice.address, 1)).to.be.revertedWithCustomError(dex, "InvalidToken");
    });

    it("un swap tan chico que daría 0 revierte en lugar de quedarse con los tokens", async function () {
      const { alice, dex } = await deploy();
      await dex.addLiquidity(E(1000), 1000n);
      await expect(dex.connect(alice).swapAforB(1n, 0)).to.be.revertedWithCustomError(dex, "InsufficientOutput");
    });
  });

  describe("tokens no estándar", function () {
    it("token con comisión por transferencia: usa lo que realmente llegó", async function () {
      const [owner, alice] = await ethers.getSigners();
      const fee = await (await ethers.getContractFactory("FeeToken")).deploy();
      const tB = await (await ethers.getContractFactory("TokenB")).deploy();
      const dex = await (await ethers.getContractFactory("SimpleDEX")).deploy(await fee.getAddress(), await tB.getAddress());
      const d = await dex.getAddress();
      await fee.approve(d, ethers.MaxUint256);
      await tB.approve(d, ethers.MaxUint256);
      await dex.addLiquidity(E(1000), E(1000));
      expect(await dex.reserveA()).to.equal(E(990)); // llegó 1 % menos
      expect(await fee.balanceOf(d)).to.equal(await dex.reserveA());
      await fee.transfer(alice.address, E(200));
      await fee.connect(alice).approve(d, ethers.MaxUint256);
      await dex.connect(alice).swapAforB(E(100), 0);
      expect(await fee.balanceOf(d)).to.equal(await dex.reserveA()); // reservas = saldo real
      expect(owner.address).to.be.properAddress;
    });

    it("token que devuelve false: SafeERC20 revierte en vez de regalar tokens", async function () {
      const [, alice] = await ethers.getSigners();
      const bad = await (await ethers.getContractFactory("FalseReturnToken")).deploy();
      const tB = await (await ethers.getContractFactory("TokenB")).deploy();
      const dex = await (await ethers.getContractFactory("SimpleDEX")).deploy(await bad.getAddress(), await tB.getAddress());
      const d = await dex.getAddress();
      await bad.approve(d, ethers.MaxUint256);
      await tB.approve(d, ethers.MaxUint256);
      await dex.addLiquidity(E(1000), E(1000));
      // alice no tiene tokens ni allowance: el transferFrom devuelve false
      await expect(dex.connect(alice).swapAforB(E(100), 0)).to.be.revertedWithCustomError(dex, "SafeERC20FailedOperation");
    });

    it("con el contrato original, ese mismo token permite sacar tokens sin pagar", async function () {
      const [, alice] = await ethers.getSigners();
      const bad = await (await ethers.getContractFactory("FalseReturnToken")).deploy();
      const tB = await (await ethers.getContractFactory("TokenB")).deploy();
      const dex = await (await ethers.getContractFactory("SimpleDEXOriginal")).deploy(await bad.getAddress(), await tB.getAddress());
      const d = await dex.getAddress();
      await bad.approve(d, ethers.MaxUint256);
      await tB.approve(d, ethers.MaxUint256);
      await dex.addLiquidity(E(1000), E(1000));
      await dex.connect(alice).swapAforB(E(100)); // alice no pagó nada…
      expect(await tB.balanceOf(alice.address)).to.be.gt(0); // …y recibió token B
    });
  });
});
