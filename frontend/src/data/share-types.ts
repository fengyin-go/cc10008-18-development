/**
 * 数据分享的领域类型。
 *
 * 关键约束：分享链接在生成时冻结一份快照（包含水印内容、报告模板与目标数据集字段），
 * 之后模板改名、数据集调整、分享配置变更都不会回写快照。访问只认链接自己的快照与计数。
 */

export type ShareLinkState = 'active' | 'revoked' | 'expired' | 'exhausted'

export type ShareAccessCode =
  | 'OK'
  | 'BAD_PASSWORD'
  | 'REVOKED'
  | 'EXPIRED'
  | 'VIEW_LIMIT_REACHED'
  | 'DOWNLOAD_DISABLED'
  | 'NOT_FOUND'
  | 'SNAPSHOT_INVALID'

export type ShareVisitAction = 'preview' | 'download'

export type ShareAccessLabel = Record<ShareAccessCode, string>

/** 失败原因的固定文案，页面、批次记录与导出的说明都用这同一份，避免各处写法不一致。 */
export const SHARE_ACCESS_LABELS: ShareAccessLabel = {
  OK: '访问成功',
  BAD_PASSWORD: '访问密码错误',
  REVOKED: '链接已撤销',
  EXPIRED: '链接已过期',
  VIEW_LIMIT_REACHED: '浏览次数已耗尽',
  DOWNLOAD_DISABLED: '下载已关闭',
  NOT_FOUND: '链接不存在',
  SNAPSHOT_INVALID: '分享快照缺失或校验失败',
}

export const SHARE_STATE_LABELS: Record<ShareLinkState, string> = {
  active: '已生效',
  revoked: '已撤销',
  expired: '已过期',
  exhausted: '次数耗尽',
}

/** 生成链接时冻结的展示内容。任何字段都只来自生成那一刻的数据。 */
export type ShareSnapshot = {
  version: 1
  capturedAt: string
  linkCode: string
  shareId: number
  targetDataset: string
  datasetId: string
  datasetName: string
  datasetSourceTable: string
  templateId: string
  templateName: string
  templateChartList: string
  templatePeriod: string
  templateExportFormat: string
  templatePushChannel: string
  templateWatermarkEnabled: string
  watermarkContent: string
  downloadEnabled: boolean
  /** 生成时对除 checksum 外全部字段做的稳定哈希，访问时重算，防止快照被改写。 */
  checksum: string
}

/** 一次访问批次。密码错误、次数耗尽等失败也留痕，但 counted=false，不占浏览次数。 */
export type ShareVisitBatch = {
  id: string
  at: string
  channel: string
  action: ShareVisitAction
  result: ShareAccessCode
  resultLabel: string
  counted: boolean
  message: string
}

/** 持久化的分享链接记录。password 只在生成时绑定，之后改分享配置不影响它。 */
export type ShareLinkRecord = {
  token: string
  shareId: number
  linkCode: string
  createdAt: string
  expiresAt: string
  validityDays: number
  maxViews: number
  viewCount: number
  password: string
  downloadEnabled: boolean
  autoCleanup: boolean
  status: ShareLinkState
  revokedAt: string | null
  revokedReason: string
  firstViewedAt: string | null
  lastViewedAt: string | null
  snapshot: ShareSnapshot
  visits: ShareVisitBatch[]
}

/** 给管理端展示的链接摘要：永远不返回访问密码，只告诉调用方是否需要密码。 */
export type ShareLinkSummary = Omit<ShareLinkRecord, 'password'> & {
  passwordRequired: boolean
  snapshotValid: boolean
  effectiveStatus: ShareLinkState
  remainingViews: number
  active: boolean
}

export type ShareAccessResult = {
  ok: boolean
  code: ShareAccessCode
  message: string
  status: ShareLinkState | 'missing'
  token: string
  channel: string
  downloadAllowed: boolean
  viewCount: number
  maxViews: number
  remainingViews: number
  firstViewedAt: string | null
  snapshot: ShareSnapshot | null
  file?: { filename: string; mimeType: string; content: string }
  /** 是否真的写了访问批次。 */
  recorded: boolean
  isFirstVisit: boolean
}

export type ShareGenerateResult = {
  ok: boolean
  message: string
  reused: boolean
  link: ShareLinkSummary | null
}

export type ShareRevokeResult = {
  ok: boolean
  message: string
  revoked: number
}

export type ShareIssueCode =
  | 'DUPLICATE_ENTRY'
  | 'DUPLICATE_TOKEN'
  | 'DUPLICATE_ACTIVE_LINK'
  | 'ORPHAN_LINK'
  | 'MISSING_TOKEN'
  | 'MISSING_SNAPSHOT'
  | 'MISSING_WATERMARK'
  | 'SNAPSHOT_CHECKSUM_MISMATCH'
  | 'STALE_STATUS'
  | 'INVALID_VISIT_BATCH'
  | 'INVALID_CONFIG'
  | 'ACTIVE_WITHOUT_LINK'

export type ShareIssue = {
  code: ShareIssueCode
  severity: 'info' | 'warning' | 'error'
  shareId: number | null
  token: string
  message: string
}

export type ShareDiagnosis = {
  issues: ShareIssue[]
  linkCount: number
  entryCount: number
}

/** 管理端自检结果：只读，不写访问批次、不消耗次数。 */
export type ShareLinkInspection = {
  ok: boolean
  message: string
  link: ShareLinkSummary | null
  snapshot: ShareSnapshot | null
  problem: ShareAccessCode | null
  downloadAllowed: boolean
  visits: ShareVisitBatch[]
  stateLabel: string
}

export type ShareCleanupResult = {
  removed: number
  deduped: number
  orphans: number
  repaired: number
  messages: string[]
}

export type ShareStats = {
  total: number
  active: number
  pending: number
}

export type ShareClockOption = {
  now?: number | string | Date
}

export type ShareAccessOptions = ShareClockOption & {
  password?: string
  channel?: string
}

export type ShareGenerateOptions = ShareClockOption & {
  channel?: string
}

export type ShareListOptions = ShareClockOption & {
  shareId?: number
  includeRevoked?: boolean
  keyword?: string
}
