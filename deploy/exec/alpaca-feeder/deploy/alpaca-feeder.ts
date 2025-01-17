import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers, upgrades } from "hardhat";
import { AlpacaFeeder, AlpacaFeeder__factory, ProxyToken, ProxyToken__factory } from "../../../../typechain";
import { FairLaunch__factory, Timelock__factory } from "@alpaca-finance/alpaca-contract/typechain";
import { ConfigEntity } from "../../../entities";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  /*
    ░██╗░░░░░░░██╗░█████╗░██████╗░███╗░░██╗██╗███╗░░██╗░██████╗░
    ░██║░░██╗░░██║██╔══██╗██╔══██╗████╗░██║██║████╗░██║██╔════╝░
    ░╚██╗████╗██╔╝███████║██████╔╝██╔██╗██║██║██╔██╗██║██║░░██╗░
    ░░████╔═████║░██╔══██║██╔══██╗██║╚████║██║██║╚████║██║░░╚██╗
    ░░╚██╔╝░╚██╔╝░██║░░██║██║░░██║██║░╚███║██║██║░╚███║╚██████╔╝
    ░░░╚═╝░░░╚═╝░░╚═╝░░╚═╝╚═╝░░╚═╝╚═╝░░╚══╝╚═╝╚═╝░░╚══╝░╚═════╝░
    Check all variables below before execute the deployment script
    */
  const POOL_ID = "22";

  const config = ConfigEntity.getConfig();
  const deployer = (await ethers.getSigners())[0];
  let nonce = await deployer.getTransactionCount();

  const alpacaGrassHouseAddress = config.GrassHouses.find((gh) => gh.name === "ALPACA");
  if (alpacaGrassHouseAddress === undefined) throw new Error(`could not find ALPACA GrassHouse`);

  console.log(`>> Deploying AlpacaFeeder`);
  const AlpacaFeeder = (await ethers.getContractFactory("AlpacaFeeder", deployer)) as AlpacaFeeder__factory;
  const alpacaFeeder = (await upgrades.deployProxy(AlpacaFeeder, [
    config.Tokens.ALPACA,
    config.Tokens.fdALPACA,
    config.FairLaunch.address,
    POOL_ID,
    alpacaGrassHouseAddress.address,
  ])) as AlpacaFeeder;
  await alpacaFeeder.deployed();
  nonce++;
  console.log(`>> Deployed at ${alpacaFeeder.address}`);
  console.log("✅ Done");

  console.log(">> Transferring ownership and set okHolders of proxyToken to be alpacaFeeder");
  const proxyToken = ProxyToken__factory.connect(config.Tokens.fdALPACA, deployer);
  await proxyToken.setOkHolders([alpacaFeeder.address, config.FairLaunch.address], true, { nonce: nonce++ });
  await proxyToken.transferOwnership(alpacaFeeder.address, { nonce: nonce++ });
  console.log("✅ Done");

  console.log(">> Sleep for 10000msec waiting for alpacaFeeder to completely deployed");
  await new Promise((resolve) => setTimeout(resolve, 10000));
  console.log("✅ Done");

  console.log(">> Depositing proxyToken to Fairlaunch pool");
  await alpacaFeeder.fairLaunchDeposit({ nonce });
  console.log("✅ Done");
};

export default func;
func.tags = ["AlpacaFeeder"];
