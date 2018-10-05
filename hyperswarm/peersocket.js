const EventEmitter = require('events')
const crypto = require('crypto')
const createSwarm = require('@hyperswarm/network')
const lpstream = require('length-prefixed-stream')
const schemas = require('./peersocket-schemas')
const {extractOrigin} = require('../../../lib/strings')

// globals
// =

var swarms = new Map() // origin -> hyperswarm net instance

// exported APIs
// =

module.exports = {
  getSwarm,
  getOrCreateSwarm,
  getLobby,
  getOrCreateLobby,
  leaveLobby,
  getLobbyConnection,
  encodeMsg,
  decodeMsg
}

function getSwarm (sender, tabIdentity) {
  return swarms.get(getSwarmId(sender, tabIdentity))
}

function getOrCreateSwarm (sender, tabIdentity) {
  var swarm = getSwarm(sender, tabIdentity)
  if (!swarm) swarm = createSwarm(sender, tabIdentity)
  return swarm
}

function getLobby (sender, tabIdentity, lobbyType, lobbyName) {
  var swarm = getSwarm(sender, tabIdentity)
  if (swarm) {
    var topic = createLobbyTopic(lobbyType, lobbyName)
    if (swarm.lobbies.has(topic)) {
      return swarm.lobbies.get(topic)
    }
  }
}

function getOrCreateLobby (sender, tabIdentity, lobbyType, lobbyName) {
  var swarm = getSwarm(sender, tabIdentity)
  if (swarm) {
    var topic = createLobbyTopic(lobbyType, lobbyName)
    if (!swarm.lobbies.has(topic)) {
      // create the lobby
      var lobby = Object.assign(new EventEmitter(), {
        topic,
        name: lobbyName,
        type: lobbyType,
        connections: new Set(),
        connIdCounter: 0
      })
      swarm.lobbies.set(topic, lobby)

      // join the swarm topic
      swarm.join(topic, {lookup: true, announce: true})
    }
    return swarm.lobbies.get(topic)
  }
}

function leaveLobby (sender, tabIdentity, lobbyType, lobbyName) {
  var swarm = getSwarm(sender, tabIdentity)
  if (swarm) {
    var topic = createLobbyTopic(lobbyType, lobbyName)
    if (swarm.lobbies.has(topic)) {
      // leave the swarm topic and close all connections
      lobby.connections.forEach(({socket}) => socket.close())
      swarm.leave(topic)
      lobby.emit('leave')
      swarm.lobbies.delete(topic)
    }
  }
}

function getLobbyConnection (sender, tabIdentity, lobbyType, lobbyName, socketId) {
  var lobby = PeerSocket.getLobby(sender, tabIdentity, lobbyType, lobbyName)
  if (lobby) {
    return Array.fom(lobby.connections).find({id} => id === socketId)
  }
} 

function encodeMsg (payload) {
  var contentType
  if (Buffer.isBuffer(payload)) {
    contentType = 'application/octet-stream'
  } else {
    contentType = 'application/json'
    payload = Buffer.from(JSON.stringify(payload), 'utf8')
  }
  return schemas.PeerSocketMessage.encode({contentType, payload})
}

function decodeMsg (msg) {
  var payload
  msg = schemas.PeerSocketMessage.decode(msg)
  if (msg.contentType === 'application/json') {
    try {
      msg.payload = JSON.parse(msg.payload.toString('utf8'))
    } catch (e) {
      console.error('Failed to parse PeerSocket message', e, msg)
      msg.payload = null
    }
  }
  return msg
}

// internal methods
// =

function sha256 (str) {
  return crypto.createHash('sha256').update(str).digest()
}

function createLobbyTopic (lobbyType, lobbyName) {
  return sha256(`peersocket-${lobbyType}-${lobbyName}`)
}

function getSwarmId (sender, tabIdentity) {
  var id = extractOrigin(sender.getURL())
  if (tabIdentity) {
    id += '::' + tabIdentity
  }
  return id
}

function createSwarm (sender, tabIdentity) {
  let swarmId = getSwarmId(sender, tabIdentity)
  swarm = createSwarm({ephemeral: true})
  swarms.set(swarmId, swarm)
  swarm.lobbies = new Map()

  // handle connection events
  swarm.on('connection', (socket, details) => {
    handleConnection(swarm, socket, details)
  })
}

function handleConnection (swarm, socket, details) {
  var lobby = swarm.lobbies.get(details.topic)
  if (lobby) {
    // create the connection
    var id = ++lobby.connIdCounter
    var encoder = lpstream.encode()
    var decoder = lpstream.decode()
    var conn = {
      id,
      socket,
      details,
      events: new EventEmitter()
    }
    lobby.connections.add(conn)
    lobby.emit('connection', {socketInfo: {id}})
    encoder.pipe(socket).pipe(decoder)

    // wire up events
    decoder.on('data', message => {
      try {
        message = decodeMsg(message)
        conn.events.emit('message', {message})
      } catch (e) {
        console.log('Failed to decode received PeerSocket message', e)
      }
    })
    socket.on('close', () => {
      lobby.connections.remove(conn)
      conn.events.emit('close')
    })
  }
}
