import {
  BEP20,
  BEP20__factory,
  GrassHouse,
  GrassHouse__factory,
  GrassMaxi,
  GrassMaxi__factory,
  MockContractContext,
  MockContractContext__factory,
  PancakeFactory,
  PancakeFactory__factory,
  PancakeRouterV2,
  PancakeRouterV2__factory,
  XALPACA,
  XALPACA__factory,
  WETH__factory,
  WETH
} from "../../typechain";
import {BigNumber, Signer} from "ethers";
import {ethers, upgrades, waffle} from "hardhat";
import * as timeHelpers from "../helpers/time";
import {expect} from "chai";
import {formatEther, parseEther} from "ethers/lib/utils";

describe("GrassMaxi", () => {
  const FOREVER = "2000000000";
  const TREASURE_BPS = 30; // 0.3%
  const TOLERANCE = "0.04"; // 0.04%
  const HOUR = ethers.BigNumber.from(3600);
  const DAY = ethers.BigNumber.from(86400);
  const WEEK = DAY.mul(7);
  const YEAR = DAY.mul(365);
  const MAX_LOCK = ethers.BigNumber.from(32054399); // seconds in 53 weeks - 1 second (60 * 60 * 24 * 7 * 53) - 1
  const TOKEN_CHECKPOINT_DEADLINE = DAY;

  // Contact Instance
  let ALPACA: BEP20;
  let RewardToken1: BEP20;
  let RewardToken2: BEP20;
  let MockBUSD: BEP20;
  let wbnb: WETH;

  let xALPACA: XALPACA;
  let grassHouse1: GrassHouse;
  let grassHouse2: GrassHouse;

  let contractContext: MockContractContext;

  let pcsFactory: PancakeFactory;
  let pcsRouter: PancakeRouterV2;

  let grassMaxi: GrassMaxi;

  // GrassHouse start week cursor
  let startWeekCursor: BigNumber;

  // Accounts
  let deployer: Signer;
  let alice: Signer;
  let bob: Signer;
  let eve: Signer;

  let deployerAddress: string;
  let aliceAddress: string;
  let bobAddress: string;
  let eveAddress: string;

  // Contract Signer
  let ALPACAasAlice: BEP20;
  let ALPACAasBob: BEP20;
  let ALPACAasEve: BEP20;

  let RT1asAlice: BEP20;
  let RT1asBob: BEP20;
  let RT1asEve: BEP20;

  let RT2asAlice: BEP20;
  let RT2asBob: BEP20;
  let RT2asEve: BEP20;

  let grassMaxiasAlice: GrassMaxi;
  let grassMaxiasBob: GrassMaxi;
  let grassMaxiasEve: GrassMaxi;

  let xALPACAasAlice: XALPACA;
  let xALPACAasBob: XALPACA;
  let xALPACAasEve: XALPACA;

  let grassHouseAsAlice: GrassHouse;
  let grassHouseAsBob: GrassHouse;
  let grassHouseAsEve: GrassHouse;

  async function fixture() {
    [deployer, alice, bob, eve] = await ethers.getSigners();
    [deployerAddress, aliceAddress, bobAddress, eveAddress] = await Promise.all([
      deployer.getAddress(),
      alice.getAddress(),
      bob.getAddress(),
      eve.getAddress(),
    ]);

    // Deploy contract context
    const MockContractContext = (await ethers.getContractFactory(
      "MockContractContext",
      deployer
    )) as MockContractContext__factory;
    contractContext = await MockContractContext.deploy();

    // Deploy ALPACA & RewardToken1&2
    const BEP20 = (await ethers.getContractFactory("BEP20", deployer)) as BEP20__factory;
    ALPACA = await BEP20.deploy("ALPACA", "ALPACA");
    await ALPACA.mint(deployerAddress, ethers.utils.parseEther("888888888888888"));
    RewardToken1 = await BEP20.deploy("RewardToken1", "RT1");
    await RewardToken1.mint(deployerAddress, ethers.utils.parseEther("888888888888888"));

    RewardToken2 = await BEP20.deploy("RewardToken2", "RT2");
    await RewardToken2.mint(deployerAddress, ethers.utils.parseEther("888888888888888"));

    MockBUSD = await BEP20.deploy("MockBUSD", "MBUSD");
    await MockBUSD.mint(deployerAddress, ethers.utils.parseEther("888888888888888"));

    // Deploy xALPACA
    const XALPACA = (await ethers.getContractFactory("xALPACA", deployer)) as XALPACA__factory;
    xALPACA = (await upgrades.deployProxy(XALPACA, [ALPACA.address])) as XALPACA;
    await xALPACA.deployed();

    // Distribute ALPACA and approve xALPACA to do "transferFrom"
    for (let i = 0; i < 10; i++) {
      await ALPACA.transfer((await ethers.getSigners())[i].address, ethers.utils.parseEther("8888"));
      const alpacaWithSigner = BEP20__factory.connect(ALPACA.address, (await ethers.getSigners())[i]);
      await alpacaWithSigner.approve(xALPACA.address, ethers.constants.MaxUint256);
    }

    // Deploy GrassHouses
    startWeekCursor = (await timeHelpers.latestTimestamp()).div(WEEK).mul(WEEK);
    const GrassHouse = (await ethers.getContractFactory("GrassHouse", deployer)) as GrassHouse__factory;
    grassHouse1 = (await upgrades.deployProxy(GrassHouse, [
      xALPACA.address,
      await timeHelpers.latestTimestamp(),
      ALPACA.address,
      deployerAddress,
    ])) as GrassHouse;
    await grassHouse1.deployed();

    grassHouse2 = (await upgrades.deployProxy(GrassHouse, [
      xALPACA.address,
      await timeHelpers.latestTimestamp(),
      ALPACA.address,
      deployerAddress,
    ])) as GrassHouse;
    await grassHouse2.deployed();

    // Approve xALPACA to transferFrom contractContext
    await contractContext.executeTransaction(
      ALPACA.address,
      0,
      "approve(address,uint256)",
      ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [xALPACA.address, ethers.constants.MaxUint256])
    );

    // Setup Pancakeswap
    const PancakeFactory = (await ethers.getContractFactory("PancakeFactory", deployer)) as PancakeFactory__factory;
    pcsFactory = await PancakeFactory.deploy(await deployer.getAddress());
    await pcsFactory.deployed();

    const WBNB = (await ethers.getContractFactory("WETH", deployer)) as WETH__factory;
    wbnb = await WBNB.deploy();
    await wbnb.deployed();

    const PancakeRouter = (await ethers.getContractFactory("PancakeRouterV2", deployer)) as PancakeRouterV2__factory;
    pcsRouter = await PancakeRouter.deploy(pcsFactory.address, wbnb.address);
    await pcsRouter.deployed();

    // Setting up liquidity
    await ALPACA.approve(pcsRouter.address, ethers.constants.MaxUint256);
    await MockBUSD.approve(pcsRouter.address, ethers.constants.MaxUint256);
    await RewardToken1.approve(pcsRouter.address, ethers.constants.MaxUint256);
    await RewardToken2.approve(pcsRouter.address, ethers.constants.MaxUint256);
    // Alpaca-MBUSD liquidity 1000 Alpaca - 1000 MBUSD
    await pcsRouter.addLiquidity(
      ALPACA.address,
      MockBUSD.address,
      ethers.utils.parseEther("100"),
      ethers.utils.parseEther("100"),
      "0",
      "0",
      await deployer.getAddress(),
      FOREVER
    );

    // RewardToken1-MBUSD liquidity 100 RewardToken1 - 1000 MBUSD
    await pcsRouter.addLiquidity(
      RewardToken1.address,
      MockBUSD.address,
      ethers.utils.parseEther("100"),
      ethers.utils.parseEther("1000"),
      "0",
      "0",
      await deployer.getAddress(),
      FOREVER
    );

    // RewardToken1-WBNB liquidity 100 RewardToken2 - 10 WBNB
    await pcsRouter.addLiquidityETH(
      RewardToken2.address,
      ethers.utils.parseEther("100"),
      "0",
      "0",
      await deployer.getAddress(),
      FOREVER,
      {value: ethers.utils.parseEther("10")}
    );

    // deploy GrassMaxi
    const GrassMaxi = (await ethers.getContractFactory("GrassMaxi", deployer)) as GrassMaxi__factory;
    grassMaxi = (await upgrades.deployProxy(GrassMaxi, [
      xALPACA.address,
      ALPACA.address,
      pcsRouter.address,
      TREASURE_BPS
    ])) as GrassMaxi;
    await grassMaxi.deployed();
    // white list grassmaxi
    await xALPACA.setWhitelistCaller(grassMaxi.address, true);
    // Assign contract signer
    ALPACAasAlice = BEP20__factory.connect(ALPACA.address, alice);
    ALPACAasBob = BEP20__factory.connect(ALPACA.address, bob);
    ALPACAasEve = BEP20__factory.connect(ALPACA.address, eve);

    RT1asAlice = BEP20__factory.connect(RewardToken1.address, alice);
    RT1asBob = BEP20__factory.connect(RewardToken1.address, bob);
    RT1asEve = BEP20__factory.connect(RewardToken1.address, eve);

    RT2asAlice = BEP20__factory.connect(RewardToken2.address, alice);
    RT2asBob = BEP20__factory.connect(RewardToken2.address, bob);
    RT2asEve = BEP20__factory.connect(RewardToken2.address, eve);

    xALPACAasAlice = XALPACA__factory.connect(xALPACA.address, alice);
    xALPACAasBob = XALPACA__factory.connect(xALPACA.address, bob);
    xALPACAasEve = XALPACA__factory.connect(xALPACA.address, eve);

    grassHouseAsAlice = GrassHouse__factory.connect(grassHouse1.address, alice);
    grassHouseAsBob = GrassHouse__factory.connect(grassHouse1.address, bob);
    grassHouseAsEve = GrassHouse__factory.connect(grassHouse1.address, eve);
    grassMaxiasAlice = GrassMaxi__factory.connect(grassMaxi.address, alice);
    grassMaxiasBob = GrassMaxi__factory.connect(grassMaxi.address, bob);
  }

  beforeEach(async () => {
    await waffle.loadFixture(fixture);
  });
  describe("#initialized", async () => {
    it("should initialized correctly", async () => {
      expect(await grassMaxi.xALPACA()).to.be.eq(xALPACA.address);
      expect(await grassMaxi.ALPACA()).to.be.eq(ALPACA.address);
      expect(await grassMaxi.totalLockedAmount()).to.be.eq(0);
    });
  });
  describe("#createLock", async () => {
    it('should create lock correctly', async () => {
      await ALPACA.approve(grassMaxi.address, ethers.constants.MaxUint256);
      await grassMaxi.createLock();
      expect(await grassMaxi.totalLockedAmount()).to.gt(0);
      await expect(grassMaxi.createLock()).to.be.revertedWith("already has a lock")
    });
  })
  describe("#deposit", async () => {
    it('should have correct mxAlpaca balance for alice and bob after depositing', async () => {
      const aliceAmount = parseEther("10");
      const bobAmount = parseEther("20");
      await ALPACAasAlice.approve(grassMaxi.address, ethers.constants.MaxUint256);
      await expect(grassMaxiasAlice.deposit(aliceAmount)).to.be.revertedWith("lock not created yet");
      await ALPACA.approve(grassMaxi.address, ethers.constants.MaxUint256);
      await grassMaxi.createLock();
      await grassMaxiasAlice.deposit(aliceAmount);
      expect(await grassMaxi.balanceOf(aliceAddress)).to.be.eq(aliceAmount);
      await ALPACAasBob.approve(grassMaxi.address, ethers.constants.MaxUint256);
      await grassMaxiasBob.deposit(bobAmount);
      expect(await grassMaxi.balanceOf(bobAddress)).to.be.eq(bobAmount);
    });
  })

})