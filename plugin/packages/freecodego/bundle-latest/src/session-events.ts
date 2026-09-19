import { Service } from '@deepseek-ai/cordis'
import { registerFreeCodeGoSessionEventTypes } from './index.ts'

/** Loader prerequisite: install the plugin-owned session event vocabulary. */
export default class FreeCodeGoSessionEvents extends Service {
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'freeCodeGoSessionEvents')
    registerFreeCodeGoSessionEventTypes()
  }
}
