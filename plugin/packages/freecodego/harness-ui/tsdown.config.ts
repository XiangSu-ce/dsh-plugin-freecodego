import { clientBundle } from '../../client/tsdown.client.ts'

/** Build the FreeCodeGo browser factory without traversing unrelated client packages. */
export default clientBundle('@deepseek-ai/dsh-freecodego-harness-ui', [
  'lib/types/index.js',
])
