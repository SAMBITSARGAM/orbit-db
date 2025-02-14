'use strict'

const assert = require('assert')
const mapSeries = require('p-each-series')
const rmrf = require('rimraf')
const OrbitDB = require('../src/OrbitDB')

// Include test utilities
const {
  config,
  startIpfs,
  stopIpfs,
  connectPeers,
  waitForPeers,
  testAPIs,
} = require('orbit-db-test-utils')

const dbPath1 = './orbitdb/tests/multiple-databases/1'
const dbPath2 = './orbitdb/tests/multiple-databases/2'

const databaseInterfaces = [
  {
    name: 'logdb',
    open: async (orbitdb, address, options) => await orbitdb.log(address, options),
    write: async (db, index) => await db.add('hello' + index),
    query: (db) => db.iterator({ limit: -1 }).collect().length,
  },
  {
    name: 'feed',
    open: async (orbitdb, address, options) => await orbitdb.feed(address, options),
    write: async (db, index) => await db.add('hello' + index),
    query: (db) => db.iterator({ limit: -1 }).collect().length,
  },
  {
    name: 'key-value',
    open: async (orbitdb, address, options) => await orbitdb.keyvalue(address, options),
    write: async (db, index) => await db.put('hello', index),
    query: (db) => db.get('hello'),
  },
  {
    name: 'counterdb',
    open: async (orbitdb, address, options) => await orbitdb.counter(address, options),
    write: async (db, index) => await db.inc(1),
    query: (db) => db.value,
  },
  {
    name: 'documents',
    open: async (orbitdb, address, options) => await orbitdb.docs(address, options),
    write: async (db, index) => await db.put({ _id: 'hello', testing: index }),
    query: (db) => {
      const docs = db.get('hello')
      return docs ? docs[0].testing : 0
    },
  },
]

Object.keys(testAPIs).forEach(API => {
  describe(`orbit-db - Multiple Databases (${API})`, function() {
    this.timeout(config.timeout)

    let ipfsd1, ipfsd2, ipfs1, ipfs2
    let orbitdb1, orbitdb2, db1, db2, db3, db4

    let localDatabases = []
    let remoteDatabases = []

    // Create two IPFS instances and two OrbitDB instances (2 nodes/peers)
    before(async () => {
      rmrf.sync(dbPath1)
      rmrf.sync(dbPath2)

      ipfsd1 = await startIpfs(API, config.daemon1)
      ipfsd2 = await startIpfs(API, config.daemon2)
      ipfs1 = ipfsd1.api
      ipfs2 = ipfsd2.api
      // Connect the peers manually to speed up test times
      const isLocalhostAddress = (addr) => addr.toString().includes('127.0.0.1')
      await connectPeers(ipfs1, ipfs2, { filter: isLocalhostAddress })
      console.log("Peers connected")
      orbitdb1 = await OrbitDB.createInstance(ipfs1, { directory: dbPath1 })
      orbitdb2 = await OrbitDB.createInstance(ipfs2, { directory: dbPath2 })
    })

    after(async () => {
      if(orbitdb1)
        await orbitdb1.stop()

      if(orbitdb2)
        await orbitdb2.stop()

      if (ipfsd1)
        await stopIpfs(ipfsd1)

      if (ipfsd2)
        await stopIpfs(ipfsd2)
    })

    beforeEach(async () => {
      let options = {}
      // Set write access for both clients
      options.write = [
        orbitdb1.identity.publicKey,
        orbitdb2.identity.publicKey
      ],

      console.log("Creating databases and waiting for peers to connect")

      // Open the databases on the first node
      options = Object.assign({}, options, { create: true })

      // Open the databases on the first node
      for (let dbInterface of databaseInterfaces) {
        const db = await dbInterface.open(orbitdb1, dbInterface.name, options)
        localDatabases.push(db)
      }

      for (let [index, dbInterface] of databaseInterfaces.entries()) {
        const address = localDatabases[index].address.toString()
        const db = await dbInterface.open(orbitdb2, address, options)
        remoteDatabases.push(db)
      }

      // Wait for the peers to connect
      await waitForPeers(ipfs1, [orbitdb2.id], localDatabases[0].address.toString())
      await waitForPeers(ipfs2, [orbitdb1.id], localDatabases[0].address.toString())

      console.log("Peers connected")
    })

    afterEach(async () => {
      for (let db of remoteDatabases)
        await db.drop()

      for (let db of localDatabases)
        await db.drop()
    })

    it('replicates multiple open databases', async () => {
      const entryCount = 32
      const entryArr = []

      // Create an array that we use to create the db entries
      for (let i = 1; i < entryCount + 1; i ++)
        entryArr.push(i)

      // Write entries to each database
      console.log("Writing to databases")
      for (let index = 0; index < databaseInterfaces.length; index++) {
        const dbInterface = databaseInterfaces[index]
        const db = localDatabases[index]
        await mapSeries(entryArr, val => dbInterface.write(db, val))
      }

      // Function to check if all databases have been replicated
      const allReplicated = () => {
        return remoteDatabases.every(db => db._oplog.length === entryCount)
      }

      console.log("Waiting for replication to finish")

      return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          if (allReplicated()) {
            clearInterval(interval)
            // Verify that the databases contain all the right entries
            databaseInterfaces.forEach((dbInterface, index) => {
              const db = remoteDatabases[index]
              const result = dbInterface.query(db)
              assert.equal(result, entryCount)
              assert.equal(db._oplog.length, entryCount)
            })
            resolve()
          }
        }, 200)
      })
    })
  })
})
