import { describe, expect, it, vi, afterEach } from 'vitest'
import { postSlack } from './notify'

afterEach(() => vi.unstubAllGlobals())

describe('postSlack', () => {
  it('posts the text as JSON', async () => {
    // The signature is supplied as a type argument rather than inferred from
    // the implementation. `vi.fn(async () => ...)` alone infers a ZERO-ARG
    // mock, which makes `fn.mock.calls[0][1]` a type error - indexing an
    // empty tuple - even though it works at runtime. tsconfig includes
    // `**/*.ts`, so this file is typechecked and `next build` fails on it.
    const fn = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => new Response('ok', { status: 200 }),
    )
    vi.stubGlobal('fetch', fn)
    await postSlack('https://hooks.slack.com/services/x', 'hello')
    const init = fn.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello' })
  })

  it('throws on a rejection, so the caller does not stamp the orders as alerted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid_token', { status: 403 })))
    await expect(postSlack('https://hooks.slack.com/services/x', 'hi')).rejects.toThrow(/403/)
  })
})
