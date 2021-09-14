import { MockContract, smockit } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { ethers, waffle } from "hardhat"
import { Exchange, UniswapV3Pool } from "../../typechain"
import { ADDR_GREATER_THAN, ADDR_LESS_THAN, mockedBaseTokenTo } from "../clearingHouse/fixtures"
import { mockedExchangeFixture } from "./fixtures"

describe("Exchange Spec", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const POOL_A_ADDRESS = "0x000000000000000000000000000000000000000A"
    const POOL_B_ADDRESS = "0x000000000000000000000000000000000000000B"
    const DEFAULT_FEE = 3000

    let exchange: Exchange
    let baseToken: MockContract
    let quoteToken: MockContract
    let uniV3Factory: MockContract
    let clearingHouse: MockContract

    beforeEach(async () => {
        const _exchangeFixtures = await loadFixture(mockedExchangeFixture)
        exchange = _exchangeFixtures.exchange
        baseToken = _exchangeFixtures.mockedBaseToken
        quoteToken = _exchangeFixtures.mockedQuoteToken
        uniV3Factory = _exchangeFixtures.mockedUniV3Factory
        clearingHouse = _exchangeFixtures.mockedClearingHouse

        // uniV3Factory.getPool always returns POOL_A_ADDRESS
        uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
            return POOL_A_ADDRESS
        })

        baseToken.smocked.getIndexPrice.will.return.with(parseEther("100"))
    })

    describe("# initialize", () => {
        it("force error, invalid clearingHouse address", async () => {
            const exchangeFactory = await ethers.getContractFactory("Exchange")
            const exchange = (await exchangeFactory.deploy()) as Exchange
            await expect(
                exchange.initialize(wallet.address, uniV3Factory.address, quoteToken.address),
            ).to.be.revertedWith("EX_CHANC")
        })

        it("force error, invalid uniswapV3Factory address", async () => {
            const exchangeFactory = await ethers.getContractFactory("Exchange")
            const exchange = (await exchangeFactory.deploy()) as Exchange
            await expect(
                exchange.initialize(clearingHouse.address, wallet.address, quoteToken.address),
            ).to.be.revertedWith("EX_UANC")
        })

        it("force error, invalid quoteToken address", async () => {
            const exchangeFactory = await ethers.getContractFactory("Exchange")
            const exchange = (await exchangeFactory.deploy()) as Exchange
            await expect(
                exchange.initialize(clearingHouse.address, uniV3Factory.address, wallet.address),
            ).to.be.revertedWith("EX_QANC")
        })
    })

    describe("# addPool", () => {
        let poolFactory
        let pool
        let mockedPool
        beforeEach(async () => {
            poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
        })

        describe("after the pool is initialized", () => {
            beforeEach(async () => {
                mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
            })

            // @SAMPLE - addPool
            it("add a UniswapV3 pool and send an event", async () => {
                // check event has been sent
                await expect(exchange.addPool(baseToken.address, DEFAULT_FEE))
                    .to.emit(exchange, "PoolAdded")
                    .withArgs(baseToken.address, DEFAULT_FEE, mockedPool.address)

                expect(await exchange.getPool(baseToken.address)).to.eq(mockedPool.address)
            })

            it("add multiple UniswapV3 pools", async () => {
                await exchange.addPool(baseToken.address, DEFAULT_FEE)
                expect(await exchange.getPool(baseToken.address)).to.eq(mockedPool.address)

                const baseToken2 = await mockedBaseTokenTo(ADDR_LESS_THAN, quoteToken.address)
                baseToken2.smocked.balanceOf.will.return.with(ethers.constants.MaxUint256)
                baseToken2.smocked.isInWhitelist.will.return.with(true)
                const pool2 = poolFactory.attach(POOL_B_ADDRESS) as UniswapV3Pool
                const mockedPool2 = await smockit(pool2)
                uniV3Factory.smocked.getPool.will.return.with(mockedPool2.address)
                mockedPool2.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])

                await exchange.addPool(baseToken2.address, DEFAULT_FEE)
                // verify isPoolExisted
                expect(await exchange.getPool(baseToken2.address)).to.eq(mockedPool2.address)
            })

            it("force error, pool is not existent in uniswap v3", async () => {
                uniV3Factory.smocked.getPool.will.return.with(() => {
                    return EMPTY_ADDRESS
                })
                await expect(exchange.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_NEP")
            })

            it("force error, pool is already existent in ClearingHouse", async () => {
                await exchange.addPool(baseToken.address, DEFAULT_FEE)
                await expect(exchange.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_EP")
            })

            it("force error, pool is existed in Exchange even with the same base but diff fee", async () => {
                await exchange.addPool(baseToken.address, DEFAULT_FEE)
                uniV3Factory.smocked.getPool.will.return.with((token0: string, token1: string, feeRatio: BigNumber) => {
                    return POOL_B_ADDRESS
                })
                await expect(exchange.addPool(baseToken.address, 10000)).to.be.revertedWith("EX_EP")
            })

            it("force error, base must be smaller than quote to force base = token0 and quote = token1", async () => {
                const tokenWithLongerAddr = await mockedBaseTokenTo(ADDR_GREATER_THAN, quoteToken.address)
                tokenWithLongerAddr.smocked.balanceOf.will.return.with(ethers.constants.MaxUint256)
                await expect(exchange.addPool(tokenWithLongerAddr.address, DEFAULT_FEE)).to.be.revertedWith("EX_IB")
            })

            it("force error, base token balance in clearing house not enough", async () => {
                const baseToken2 = await mockedBaseTokenTo(ADDR_LESS_THAN, quoteToken.address)
                const pool2 = poolFactory.attach(POOL_B_ADDRESS) as UniswapV3Pool
                const mockedPool2 = await smockit(pool2)
                uniV3Factory.smocked.getPool.will.return.with(mockedPool2.address)
                mockedPool2.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])

                await expect(exchange.addPool(baseToken2.address, DEFAULT_FEE)).revertedWith("EX_CHBNE")
            })
        })

        it("force error, before the pool is initialized", async () => {
            await expect(exchange.addPool(baseToken.address, DEFAULT_FEE)).to.be.revertedWith("EX_PNI")
        })

        it("force error, base token is not contract", async () => {
            await expect(exchange.addPool(EMPTY_ADDRESS, DEFAULT_FEE)).to.be.revertedWith("EX_ANC")
        })
    })

    describe("onlyOwner setters", () => {
        beforeEach(async () => {
            const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
            const pool = poolFactory.attach(POOL_A_ADDRESS) as UniswapV3Pool
            const mockedPool = await smockit(pool)
            uniV3Factory.smocked.getPool.will.return.with(mockedPool.address)
            mockedPool.smocked.slot0.will.return.with(["100", 0, 0, 0, 0, 0, false])
        })

        it("setFeeRatio", async () => {
            await exchange.addPool(baseToken.address, DEFAULT_FEE)
            await exchange.setFeeRatio(baseToken.address, 10000) // 1%
            expect(await exchange.getFeeRatio(baseToken.address)).eq(10000)
        })

        it("force error, ratio overflow", async () => {
            await exchange.addPool(baseToken.address, DEFAULT_FEE)
            const twoHundredPercent = 2000000 // 200% in uint24
            await expect(exchange.setFeeRatio(baseToken.address, twoHundredPercent)).to.be.revertedWith("EX_RO")
        })

        it("force error, pool not exists", async () => {
            await expect(exchange.setFeeRatio(baseToken.address, 10000)).to.be.revertedWith("EX_PNE")
        })
    })
})
