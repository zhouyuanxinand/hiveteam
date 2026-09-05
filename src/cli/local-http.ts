import { request } from 'node:http'

export interface LocalHttpResponse {
  json: () => Promise<unknown>
  ok: boolean
  status: number
  text: () => Promise<string>
}

export interface LocalHttpRequestInit {
  body?: string
  headers?: Record<string, string>
  method?: string
}

/**
 * Minimal loopback HTTP client for the CLI. Node's global fetch (undici)
 * spends ~14ms per request on Windows loopback where node:http spends ~1ms,
 * and the `team` CLI is on the Orchestrator's task turnaround path.
 */
export const fetchLocalRuntime = async (
  url: string,
  init: LocalHttpRequestInit = {}
): Promise<LocalHttpResponse> => {
  const target = new URL(url)
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        headers: init.headers,
        hostname: target.hostname,
        method: init.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        port: target.port,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = response.statusCode ?? 0
          resolve({
            json: async () => JSON.parse(text) as unknown,
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
          })
        })
        response.on('error', reject)
      }
    )
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}
