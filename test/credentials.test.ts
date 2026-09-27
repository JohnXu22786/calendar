import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { CredentialResolver, defaultStorePath } from '../src/credentials.js'
import { stripUserinfo } from '../src/service.js'

describe('CredentialResolver.redact (secret leakage guards)', () => {
  it('masks resolved secrets even when they contain @', async () => {
    const env = () => ({ CALDAV_PASSWORD: 'p@ss:word@x', CALDAV_USERNAME: 'user' })
    const resolver = new CredentialResolver({ env })
    await resolver.get('CALDAV_PASSWORD')
    expect(resolver.redact('my p@ss:word@x is secret')).toBe('my *** is secret')
  })

  it('masks URL userinfo including @ in the password', () => {
    const resolver = new CredentialResolver({})
    expect(resolver.redact('error for https://user:p@ss@host/dav/ path'))
      .toBe('error for https://***@host/dav/ path')
    expect(resolver.redact('https://user:pass@host/x')).toBe('https://***@host/x')
    // no scheme -> untouched
    expect(resolver.redact('user:pass@host')).toBe('user:pass@host')
  })

  it('does not corrupt plain text', () => {
    const resolver = new CredentialResolver({})
    expect(resolver.redact('a normal message with no secrets.')).toBe('a normal message with no secrets.')
  })

  it('helps when a long value is configured somewhere', async () => {
    let called = false
    const env = () => ({})
    const service = {
      resolve: async (name: string) => {
        if (name === 'CALDAV_PASSWORD') { called = true; return { value: 'super-secret-value-1234' } }
        return undefined
      },
    }
    const resolver = new CredentialResolver({ env, service })
    await resolver.get('CALDAV_PASSWORD')
    expect(called).toBe(true)
    expect(resolver.redact('the super-secret-value-1234 appears here')).toContain('***')
  })
})

describe('stripUserinfo', () => {
  it('removes userinfo from URLs and leaves the rest intact', () => {
    expect(stripUserinfo('https://user:pw@host/dav/')).toBe('https://host/dav/')
    expect(stripUserinfo('https://host/dav/')).toBe('https://host/dav/')
    expect(stripUserinfo('https://user:p@ss@host:8080/x/')).toBe('https://host:8080/x/')
  })
})

describe('defaultStorePath', () => {
  it('is inside the given directory', () => {
    expect(defaultStorePath('C:\\tmp\\proj')).toBe(path.join('C:\\tmp\\proj', '.calendar-credentials.json'))
  })
})
