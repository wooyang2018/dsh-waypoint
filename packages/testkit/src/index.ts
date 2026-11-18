/**
 * `@dsh-waypoint/testkit` public surface.
 *
 * @module @dsh-waypoint/testkit
 */

export { FakeRemoteHost, startFakeHost } from './fake-host.ts'
export type { FakeHostAddress, FakeHostOptions, FakeRequest } from './fake-host.ts'
export { createFixtures, summarize } from './fixtures.ts'
export type { FakeSession, FakeWorkspace, Fixtures } from './fixtures.ts'
