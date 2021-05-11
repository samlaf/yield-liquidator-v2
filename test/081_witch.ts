import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'

import { constants } from '@yield-protocol/utils-v2'
const { WAD } = constants

import { Cauldron } from '../typechain/Cauldron'
import { Join } from '../typechain/Join'
import { Witch } from '../typechain/Witch'
import { FYToken } from '../typechain/FYToken'
import { ERC20Mock } from '../typechain/ERC20Mock'
import { OracleMock } from '../typechain/OracleMock'
import { ChainlinkMultiOracle } from '../typechain/ChainlinkMultiOracle'
import { SourceMock } from '../typechain/SourceMock'

import { ethers, waffle } from 'hardhat'
import { expect } from 'chai'
const { loadFixture } = waffle

import { YieldEnvironment } from './shared/fixtures'
import { LadleWrapper } from '../src/ladleWrapper'

describe('Witch', function () {
  this.timeout(0)

  let env: YieldEnvironment
  let ownerAcc: SignerWithAddress
  let otherAcc: SignerWithAddress
  let owner: string
  let other: string
  let cauldron: Cauldron
  let ladle: LadleWrapper
  let witch: Witch
  let witchFromOther: Witch
  let fyToken: FYToken
  let base: ERC20Mock
  let ilk: ERC20Mock
  let ilkJoin: Join
  let spotOracle: ChainlinkMultiOracle
  let spotSource: SourceMock

  const mockVaultId = ethers.utils.hexlify(ethers.utils.randomBytes(12))

  async function fixture() {
    return await YieldEnvironment.setup(ownerAcc, [baseId, ilkId], [seriesId])
  }

  before(async () => {
    const signers = await ethers.getSigners()
    ownerAcc = signers[0]
    owner = await ownerAcc.getAddress()

    otherAcc = signers[1]
    other = await otherAcc.getAddress()
  })

  const baseId = ethers.utils.hexlify(ethers.utils.randomBytes(6))
  const ilkId = ethers.utils.hexlify(ethers.utils.randomBytes(6))
  const seriesId = ethers.utils.hexlify(ethers.utils.randomBytes(6))
  let vaultId: string

  beforeEach(async () => {
    env = await loadFixture(fixture)
    cauldron = env.cauldron
    ladle = env.ladle
    witch = env.witch
    base = env.assets.get(baseId) as ERC20Mock
    ilk = env.assets.get(ilkId) as ERC20Mock
    ilkJoin = env.joins.get(ilkId) as Join
    fyToken = env.series.get(seriesId) as FYToken
    spotOracle = (env.oracles.get(ilkId) as unknown) as ChainlinkMultiOracle
    spotSource = (await ethers.getContractAt('SourceMock', await spotOracle.sources(baseId, ilkId))) as SourceMock

    witchFromOther = witch.connect(otherAcc)

    vaultId = (env.vaults.get(seriesId) as Map<string, string>).get(ilkId) as string
    await ladle.pour(vaultId, owner, WAD, WAD)
  })

  it('does not allow to set the initial proportion over 100%', async () => {
    await expect(witch.setInitialProportion(WAD.mul(2))).to.be.revertedWith('Only at or under 100%')
  })

  it('allows to set the initial proportion', async () => {
    expect(await witch.setInitialProportion(1))
      .to.emit(witch, 'InitialProportionSet')
      .withArgs(1)
    expect(await witch.initialProportion()).to.equal(1)
  })

  it('allows to set the auction time', async () => {
    expect(await witch.setAuctionTime(1))
      .to.emit(witch, 'AuctionTimeSet')
      .withArgs(1)
    expect(await witch.auctionTime()).to.equal(1)
  })

  it('does not allow to grab collateralized vaults', async () => {
    await expect(witch.grab(vaultId)).to.be.revertedWith('Not undercollateralized')
  })

  it('does not allow to grab uninitialized vaults', async () => {
    await expect(witch.grab(mockVaultId)).to.be.revertedWith('Vault not found')
  })

  it('does not allow to buy from uninitialized vaults', async () => {
    await expect(witch.buy(mockVaultId, 0, 0)).to.be.revertedWith('Nothing to buy')
  })

  it('grabs undercollateralized vaults', async () => {
    await spotSource.set(WAD.div(2))
    await witch.grab(vaultId)
    const event = (await cauldron.queryFilter(cauldron.filters.VaultLocked(null, null)))[0]
    expect(event.args.timestamp.toNumber()).to.be.greaterThan(0)
    expect(await cauldron.auctions(vaultId)).to.equal(event.args.timestamp)
  })

  describe('once a vault has been grabbed', async () => {
    beforeEach(async () => {
      await spotSource.set(WAD.div(2))
      await witch.grab(vaultId)
    })

    it("it can't be grabbed again", async () => {
      await expect(witch.grab(vaultId)).to.be.revertedWith('Vault under auction')
    })

    it('does not buy if minimum collateral not reached', async () => {
      await expect(witch.buy(vaultId, WAD, WAD)).to.be.revertedWith('Not enough bought')
    })

    it('it can buy no collateral (coverage)', async () => {
      expect(await witch.buy(vaultId, 0, 0))
        .to.emit(witch, 'Bought')
        .withArgs(owner, vaultId, 0, 0)
    })

    it('allows to buy 1/2 of the collateral for the whole debt at the beginning', async () => {
      const baseBalanceBefore = await base.balanceOf(owner)
      const ilkBalanceBefore = await ilk.balanceOf(owner)
      await expect(witch.buy(vaultId, WAD, 0))
        .to.emit(witch, 'Bought')
        .withArgs(vaultId, owner, (await ilk.balanceOf(owner)).sub(ilkBalanceBefore), WAD)
        .to.emit(cauldron, 'VaultGiven')
        .withArgs(vaultId, owner)

      const ink = WAD.sub((await cauldron.balances(vaultId)).ink)
      expect(ink.div(10 ** 15)).to.equal(WAD.div(10 ** 15).div(2)) // Nice hack to compare up to some precision
      expect(await base.balanceOf(owner)).to.equal(baseBalanceBefore.sub(WAD))
      expect(await ilk.balanceOf(owner)).to.equal(ilkBalanceBefore.add(ink))
      expect((await cauldron.vaults(vaultId)).owner).to.equal(owner) // The vault was returned once all the debt was paid off
    })

    describe('once the auction time has passed', async () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock(await ethers.provider.getBlockNumber())).timestamp
        await ethers.provider.send('evm_mine', [now + (await witch.auctionTime()).toNumber()])
      })

      it('allows to buy all of the collateral for the whole debt at the end', async () => {
        const baseBalanceBefore = await base.balanceOf(owner)
        const ilkBalanceBefore = await ilk.balanceOf(owner)
        await expect(witch.buy(vaultId, WAD, 0)).to.emit(witch, 'Bought').withArgs(vaultId, owner, WAD, WAD)

        const ink = WAD.sub((await cauldron.balances(vaultId)).ink)
        expect(ink).to.equal(WAD)
        expect(await base.balanceOf(owner)).to.equal(baseBalanceBefore.sub(WAD))
        expect(await ilk.balanceOf(owner)).to.equal(ilkBalanceBefore.add(ink))
      })
    })
  })
})
