#!/usr/bin/env node

/**
 * Awilix benchmark lifetimes (runs in ~1 minute)
 * 
 * Created to benchmark moving to scoped lifetimes for logging in a web server.
 * 
 * Simulates a web server with each service handler having two dependencies where
 * one calls the other.
 */

var { createContainer, asFunction, Lifetime, InjectionMode } = require('awilix')
var { writeFileSync } = require('fs')
var path = require('path')
var scriptName = path.basename(__filename)

// Test matrix for all scenarios
const testMatrix = {
  // Note each service creates two dependencies.
  numberServices: [50, 100, 500, 1_000],
  maxInFlight: [1_000],
  lifetimeType: ['TRANSIENT', 'SCOPED', 'SINGLETON'],
  cacheBypass: [true, false],
}
// Duration for each test to run
const secondsPerTest = 3

// Generate test matrix
const testCases = testMatrix.numberServices
  .map((numberServices) => {
    return testMatrix.maxInFlight.map((maxInFlight) => {
      return testMatrix.lifetimeType.map((lifetimeType) => {
        return testMatrix.cacheBypass.map((cacheBypass) => {
          return { numberServices, maxInFlight, lifetimeType, cacheBypass, numberSeconds: secondsPerTest }
        })
      })
    })
  })
  .flat(4)

// Global variables, reset between each test
let totalDiInitializations
let mockLoggerIdCounter = 1
let numberLogs = 0

// Main function
async function main() {
  console.log(`Starting ${scriptName} ...`)
  console.time(scriptName)

  // Accumulator of results
  const results = []
  // Run each test case
  for (const testCase of testCases) {
    const result = await runTest(testCase)
    results.push([testCase, result])
    //printResult(testCase, result)
  }
  console.timeEnd(scriptName)
  // Write results to file
  writeFileSync('awilix_lifetime_benchmark_result.json', JSON.stringify(results, null, 2))
}

// Runs test for given options
async function runTest(opts) {
  console.log('Testing with following config:', JSON.stringify(opts, null, 2))

  const { numberSeconds, numberServices, lifetimeType, maxInFlight, cacheBypass } = opts



  // Awilix container and list of service names to resolve
  const { container, mockServiceNames } = generateAwilixConfig(numberServices, lifetimeType)
  // Local variable for test
  const startTime = new Date()
  const unresolvedPromises = new Map()
  let resolvedResults = 0
  let resolveCacheHits = 0
  let maxInFlightHit = false
  let requestNumber = 0
  let msSpentResolving = 0
  // Resetting of global variables
  numberLogs = 0
  totalDiInitializations = 0

  while (true) {
    // Increment request number
    requestNumber++
    // Use standard container or scoped depending on lifetime type
    const targetContainer = lifetimeType === 'SCOPED' ? container.createScope() : container
    const randomServiceIndex = Math.floor(Math.random() * mockServiceNames.length)
    const randomServiceName = mockServiceNames[randomServiceIndex]
    // Measure time of dependency resolution
    const resolveStartTime = new Date()
    // Resolve service
    let randomService = undefined
    if (cacheBypass) {
      const cacheResult = targetContainer.cache.get(randomServiceName)
      if (cacheResult) {
        resolveCacheHits++
        randomService = cacheResult.value
      } else {
        randomService = targetContainer.resolve(randomServiceName)
      }
    } else {
      randomService = targetContainer.resolve(randomServiceName)
    }
    // Capture time of resolution
    const timeToResolveMs = new Date() - resolveStartTime
    msSpentResolving += timeToResolveMs
    // Call desired action and chain state counting for action completing
    const resultPromise = randomService.mockAction(requestNumber).then(() => {
      resolvedResults++
      unresolvedPromises.delete[requestNumber]
    })
    // Record promise
    unresolvedPromises.set(requestNumber, resultPromise)

    // Force resolution if we've hit maximum allowed in flight
    if (unresolvedPromises.size >= maxInFlight) {
      maxInFlightHit = true
      const oldestEntry = unresolvedPromises.entries().next()
      await oldestEntry
    }
    // End test if we've reached allowed time
    const secondsElapsed = (new Date() - startTime) / 1000
    if (secondsElapsed > numberSeconds) break
  }
  // Minor time math
  const totalSeconds = (new Date() - startTime) / 1000
  const totalSecondsResolving = msSpentResolving / 1000
  // Report out
  return {
    maxInFlightHit,
    requestNumber,
    resolveCacheHits,
    numberLogs,
    resolvedResults,
    totalSeconds,
    totalSecondsResolving,
    totalDiInitializations,
  }
}

function printResult(opts, result) {
  const { numberSeconds, numberServices, lifetimeType, maxInFlight } = opts
  console.log('numberSeconds =', numberSeconds)
  console.log('lifetimeType =', lifetimeType)
  console.log('numberServices =', numberServices)
  console.log('maxInFlight =', maxInFlight)
  console.log('maxInFlightHit =', result.maxInFlightHit)
  console.log('requestNumber / second =', result.requestNumber / result.totalSeconds)
  console.log('numberLogs / second =', result.numberLogs / result.totalSeconds)
  console.log('resolvedResults / second =', result.resolvedResults / result.totalSeconds)
  console.log('\n')
}

/** Mock service layer that's resolved and called */
class MockServiceLayer {
  constructor(opts, mockRepositoryName) {
    totalDiInitializations++
    this.logger = opts.logger
    this.mockRepository = opts[mockRepositoryName]
  }

  async mockAction(x) {
    this.logger.doLog()
    return await this.mockRepository.mockAction(x)
  }
}

/** Mock "downstream" layer from service layer */
class MockRepositoryLayer {
  constructor(opts) {
    totalDiInitializations++
    this.logger = opts.logger
  }

  async mockAction(x) {
    const result = Math.random() * x
    this.logger.doLog(result)
    return result
  }
}

/** Mock logger, used to show difference between scoped and not */
class MockLogger {
  constructor() {
    totalDiInitializations++
    this.id = mockLoggerIdCounter++
  }

  doLog() {
    numberLogs++
  }
}

function generateAwilixConfig(numberOfServices, lifetimeType) {
  const mockRepositories = {}
  const mockServices = {}

  // For each service, generate a repository and associated service entity. 
  for (let index = 0; index < numberOfServices; index++) {
    const mockRepositoryName = `mockRepository${index}`
    const mockRepositoryFn = (opts) => {
      return new MockRepositoryLayer(opts)
    }
    mockRepositories[mockRepositoryName] = asFunction(mockRepositoryFn, {
      lifetime: Lifetime[lifetimeType],
    })

    const mockServiceName = `mockService${index}`
    const mockServiceFn = (opts) => {
      return new MockServiceLayer(opts, mockRepositoryName)
    }
    mockServices[mockServiceName] = asFunction(mockServiceFn, {
      lifetime: Lifetime[lifetimeType],
    })
  }

  // Create container
  const container = createContainer({
    injectionMode: InjectionMode.PROXY,
  })

  // Register all dependencies
  container.register({
    ...mockRepositories,
    ...mockServices,
    logger: asFunction(() => new MockLogger(), {
      lifetime: Lifetime[lifetimeType],
    }),
  })

  return {
    container,
    mockServiceNames: Object.keys(mockServices),
  }
}

main()
