export interface PostPairConfirmDeps {
  gatewayUrl: string
  daemonToken: string
  fetchImpl?: typeof fetch
}

export interface PairConfirmBody {
  deviceId: string
  devicePubkey: string
  name: string
  boundJti: string
}

const trimSlash = (value: string) => value.replace(/\/+$/, '')

export const postPairConfirm = async (
  deps: PostPairConfirmDeps,
  body: PairConfirmBody
): Promise<void> => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const response = await fetchImpl(`${trimSlash(deps.gatewayUrl)}/pair/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.daemonToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`gateway /pair/confirm failed: ${response.status}`)
}
