import { once } from 'node:events'
import { createTeamMailboxBroker } from '../../dist/src/server/team-mailbox-broker.js'

const input = JSON.parse(process.argv[2])
const broker = await createTeamMailboxBroker({ ...input, isActive: () => true })
process.stdout.write(`${JSON.stringify({ path: broker.path })}\n`)
process.stdin.resume()
await once(process.stdin, 'end')
await broker.close()
