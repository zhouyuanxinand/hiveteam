import { expect, test } from 'vitest'

import { compareSemverVersions } from '../../src/shared/semver.js'

test.each([
  ['1.9.0', '1.10.0'],
  ['1.0.9', '1.0.10'],
  ['1.99.99', '2.0.0'],
  ['1.0.0-alpha', '1.0.0-alpha.1'],
  ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
  ['1.0.0-alpha.beta', '1.0.0-beta'],
  ['1.0.0-beta', '1.0.0-beta.2'],
  ['1.0.0-beta.2', '1.0.0-beta.11'],
  ['1.0.0-beta.11', '1.0.0-rc.1'],
  ['1.0.0-rc.1', '1.0.0'],
  ['1.0.0-9', '1.0.0-a'],
  ['1.0.0-A', '1.0.0-a'],
  ['9007199254740992.0.0', '9007199254740993.0.0'],
  ['1.0.0-9007199254740992', '1.0.0-9007199254740993'],
])('orders %s before %s using SemVer precedence', (older, newer) => {
  expect(compareSemverVersions(older, newer)).toBe(-1)
  expect(compareSemverVersions(newer, older)).toBe(1)
})

test.each([
  ['0.0.0', '0.0.0'],
  ['2.1.19+first', '2.1.19+second'],
  ['1.0.0-alpha+001', '1.0.0-alpha+999'],
  ['1.0.0-x-y-z.--+build.01', '1.0.0-x-y-z.--'],
])('treats %s and %s as equal in precedence', (left, right) => {
  expect(compareSemverVersions(left, right)).toBe(0)
})

test.each([
  '',
  'unknown',
  'v1.0.0',
  '1.0',
  '01.0.0',
  '1.00.0',
  '1.0.01',
  '1.0.0-01',
  '1.0.0-alpha.01',
  '1.0.0-',
  '1.0.0-alpha..beta',
  '1.0.0+',
  '1.0.0+build..1',
  '1.0.0-beta_1',
  '1.0.0-中文',
  ' 1.0.0',
  '1.0.0 ',
  '1.0.0\n',
  '1.0.0\r\n',
])('rejects invalid version %j on either side', (invalid) => {
  expect(compareSemverVersions(invalid, '1.0.0')).toBeNull()
  expect(compareSemverVersions('1.0.0', invalid)).toBeNull()
})
