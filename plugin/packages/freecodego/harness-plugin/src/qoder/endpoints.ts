/**
 * Qoder region endpoints and the OAuth client id.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/endpoints
 */

import type { QoderEndpoints, QoderRegion } from './types.ts'

/** The public OAuth client id Qoder's device flow registers under. */
export const QODER_OAUTH_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'
/** How long one browser authorization stays answerable. */
export const QODER_LOGIN_STATE_TTL_MS = 10 * 60_000
/** Interval between device-token polls. */
export const QODER_LOGIN_POLL_INTERVAL_MS = 1_000

const ENDPOINTS_GLOBAL: QoderEndpoints = {
  deviceLoginBase: 'https://qoder.com/device/selectAccounts',
  pollEndpoint: 'https://openapi.qoder.sh/api/v1/deviceToken/poll',
  userinfoBase: 'https://openapi.qoder.sh/api/v1/userinfo',
  planEndpoint: 'https://openapi.qoder.sh/api/v2/user/plan',
  quotaEndpoint: 'https://openapi.qoder.sh/api/v2/quota/usage',
  chatStreamUrl: 'https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
  modelListUrl: 'https://api2.qoder.sh/algo/api/v2/model/list?Encode=1',
  jobTokenUrl: 'https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1',
  campaignsBase: 'https://openapi.qoder.sh',
}

const ENDPOINTS_CN: QoderEndpoints = {
  deviceLoginBase: 'https://qoder.com.cn/device/selectAccounts',
  pollEndpoint: 'https://openapi.qoder.com.cn/api/v1/deviceToken/poll',
  userinfoBase: 'https://openapi.qoder.com.cn/api/v1/userinfo',
  planEndpoint: 'https://openapi.qoder.com.cn/api/v2/user/plan',
  quotaEndpoint: 'https://openapi.qoder.com.cn/api/v2/quota/usage',
  chatStreamUrl: 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
  modelListUrl: 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1',
  jobTokenUrl: 'https://gateway.qoder.com.cn/algo/api/v3/user/jobToken?Encode=1',
  campaignsBase: 'https://openapi.qoder.com.cn',
}

/** The path one region's campaign list and claim endpoints hang off. */
export const QODER_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'

/**
 * The endpoint set for a region; an unknown region is treated as global.
 * @param region - the region to resolve.
 * @returns the region's endpoints.
 */
export function qoderEndpoints(region: QoderRegion): QoderEndpoints {
  return region === 'cn' ? ENDPOINTS_CN : ENDPOINTS_GLOBAL
}

/**
 * Normalize a region string onto a known region.
 * @param value - the untrusted region value.
 * @returns the normalized region.
 */
export function normalizeQoderRegion(value: unknown): QoderRegion {
  if (typeof value === 'string' && (value === 'cn' || value.toLowerCase() === 'cn')) return 'cn'
  return 'global'
}
