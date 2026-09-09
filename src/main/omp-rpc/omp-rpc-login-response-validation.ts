// Response readers for the auth verbs: get_login_providers and login. Kept
// apart from the other command-response families because these two are the
// only payloads that describe CREDENTIALS rather than session content, and
// they are read into a picker that must not misrepresent which accounts exist
// or which one was persisted. omp-rpc-command-response-validation.ts
// re-exports both so call sites keep one import surface.

import type { OmpRpcLoginProvider, OmpRpcLoginResult } from '../../shared/omp-rpc-protocol'
import { malformedOmpRpcResponse } from './omp-rpc-malformed-response-error'
import { isOmpRpcObject } from './omp-rpc-wire-value-readers'

/** `{ providers: [{ id, name, available, authenticated }] }`. All-or-nothing:
 *  a login picker missing a provider row silently hides the account the user
 *  came to add. */
export function parseOmpRpcLoginProviders(data: unknown): OmpRpcLoginProvider[] {
  if (!isOmpRpcObject(data) || !Array.isArray(data.providers)) {
    throw malformedOmpRpcResponse('get_login_providers')
  }
  return data.providers.map((row) => {
    if (
      !isOmpRpcObject(row) ||
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      typeof row.name !== 'string' ||
      typeof row.available !== 'boolean' ||
      typeof row.authenticated !== 'boolean'
    ) {
      throw malformedOmpRpcResponse('get_login_providers')
    }
    return {
      id: row.id,
      name: row.name,
      available: row.available,
      authenticated: row.authenticated
    }
  })
}

/** `{ providerId }` — which credential the child persisted. */
export function parseOmpRpcLoginResult(data: unknown): OmpRpcLoginResult {
  if (
    !isOmpRpcObject(data) ||
    typeof data.providerId !== 'string' ||
    data.providerId.length === 0
  ) {
    throw malformedOmpRpcResponse('login')
  }
  return { providerId: data.providerId }
}
