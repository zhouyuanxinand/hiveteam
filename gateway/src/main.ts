import { createGatewayServer } from './server.js'

const gateway = createGatewayServer()
const ownerToken = gateway.store.ownerToken()
const started = await gateway.start()

console.log(`Hive Gateway listening at http://${started.host}:${started.port}`)
if (!process.env.HIVE_GATEWAY_OWNER_TOKEN) {
  console.log(`HIVE_GATEWAY_OWNER_TOKEN=${ownerToken}`)
  console.log('Set this token before deploying the gateway to a public server.')
}
