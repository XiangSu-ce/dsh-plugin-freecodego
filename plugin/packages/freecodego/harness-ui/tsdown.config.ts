import { clientBundle } from '../../client/tsdown.client.ts'

/** Build the FreeCodeGo browser factory without traversing unrelated client packages. */
export default clientBundle(import.meta.dirname, [
  'lib/types/index.js',
])
