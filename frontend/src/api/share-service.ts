/**
 * 数据分享的本地服务实现（纯前端，持久化到 localStorage）。
 *
 * 核心规则：
 * - 链接生成时冻结一份带稳定校验和的快照；之后模板改名、数据集调整都不会回写快照。
 * - 访问校验顺序：快照与水印 -> 撤销 -> 过期 -> 次数 -> 密码 -> 下载开关。
 *   任何失败原因都写入访问批次，counted=false，不消耗浏览次数。
 * - 生成链接与访问计数都是同步的读改写事务：最后一个可用次数只会被一个请求拿到；
 *   跨标签页通过 Web Locks（可用时）把访问串行化。
 * - 同一分享配置重复生成会复用同一个有效链接；同一目标数据集的其他链接各有各的快照与计数。
 */

import { listRows, resetRows, saveRows, __resetLocalStoreCacheForTests } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import type {
  ShareAccessCode,
  ShareAccessOptions,
  ShareAccessResult,
  ShareCleanupResult,
  ShareClockOption,
  ShareDiagnosis,
  ShareGenerateOptions,
  ShareGenerateResult,
  ShareIssue,
  ShareListOptions,
  ShareLinkInspection,
  ShareLinkRecord,
  ShareLinkState,
  ShareLinkSummary,
  ShareRevokeResult,
  ShareSnapshot,
  ShareStats,
  ShareVisitAction,
  ShareVisitBatch,
} from '@/data/share-types'
import { SHARE_ACCESS_LABELS, SHARE_STATE_LABELS } from '@/data/share-types'

const LINK_STORAGE_KEY = 'interactive-analytics-lab:share-links'
const LINK_ARCHIVE_KEY = 'interactive-analytics-lab:share-link-archive'
const LINK_SCHEMA_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_VALIDITY_DAYS = 30
const DEFAULT_MAX_VIEWS = 100

const LEGACY_LINK_KEYS = [
  'interactive-analytics-lab:shareLinks',
  'interactive-analytics-lab:share-links:legacy',
  'interactive-analytics-lab:shares',
]

const SHARE_UI_PREFIXES = [
  'interactive-analytics-lab:share-preview',
  'interactive-analytics-lab:share-access',
]

type StoredShareLinks = {
  version: number
  updatedAt: string
  links: ShareLinkRecord[]
}

type ShareLinkFile = { filename: string; mimeType: string; content: string }

type ShareConfig = {
  shareId: number
  linkCode: string
  targetDataset: string
  password: string
  validityDays: number
  maxViews: number
  downloadEnabled: boolean
  autoCleanup: boolean
  watermarkContent: string
  templateSelector: string
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function str(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  return String(value)
}

function trimText(value: unknown): string {
  return str(value).trim()
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const matched = str(value)
    .replace(/,/g, '')
    .match(/-?\d+(?:\.\d+)?/)
  if (!matched) {
    return fallback
  }
  const parsed = Number(matched[0])
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseDays(value: unknown): number {
  return Math.max(0, parseNumber(value, DEFAULT_VALIDITY_DAYS))
}

function parsePositiveInt(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(parseNumber(value, fallback)))
}

const TRUTHY = ['1', 'true', 'yes', 'on', '开', '开启', '打开', '启用', '允许', '是', '已开启']
const FALSY = ['0', 'false', 'no', 'off', '关', '关闭', '停用', '禁用', '不允许', '否', '未开启']

function parseFlag(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  const normalized = trimText(value).toLowerCase()
  if (!normalized) {
    return fallback
  }
  if (TRUTHY.includes(normalized)) {
    return true
  }
  if (FALSY.includes(normalized)) {
    return false
  }
  return fallback
}

function pad(value: number, size = 4): string {
  return String(value).padStart(size, '0')
}

let sequence = 0

function newToken(): string {
  sequence += 1
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `sh_${cryptoApi.randomUUID()}`
  }
  return `sh_${Date.now().toString(36)}${sequence.toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function newBatchId(): string {
  sequence += 1
  return `v_${Date.now().toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

let clockOverride: number | null = null

function toMillis(value: number | string | Date): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Date.now()
  }
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : Date.now()
  }
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function resolveNow(clock?: ShareClockOption): number {
  if (clock && clock.now !== undefined) {
    return toMillis(clock.now)
  }
  if (clockOverride !== null) {
    return clockOverride
  }
  return Date.now()
}

/** 测试与演示用：固定当前时间；传 null 恢复系统时间。 */
export function setShareClock(value: number | string | Date | null): void {
  clockOverride = value === null ? null : toMillis(value)
}

export function getShareClock(): number | null {
  return clockOverride
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null'
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return 'null'
}

function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function snapshotChecksum(snapshot: ShareSnapshot): string {
  const rest: Record<string, unknown> = { ...(snapshot as unknown as Record<string, unknown>) }
  delete rest.checksum
  return hashText(canonical(rest))
}

function snapshotProblem(snapshot: ShareSnapshot | null | undefined): ShareAccessCode | null {
  if (!snapshot || typeof snapshot !== 'object') {
    return 'SNAPSHOT_INVALID'
  }
  if (trimText(snapshot.watermarkContent) === '') {
    return 'SNAPSHOT_INVALID'
  }
  if (!snapshot.checksum || snapshotChecksum(snapshot) !== snapshot.checksum) {
    return 'SNAPSHOT_INVALID'
  }
  return null
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

let memoryLinks: ShareLinkRecord[] | null = null
let memoryArchive: ShareLinkRecord[] | null = null

function storageArea(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function normalizeLinkArray(value: unknown): ShareLinkRecord[] | null {
  let links: unknown = value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    links = (value as Record<string, unknown>).links
  }
  if (!Array.isArray(links)) {
    return null
  }
  return links.filter((item) => item && typeof item === 'object') as ShareLinkRecord[]
}

function readStorageLinks(): ShareLinkRecord[] {
  const area = storageArea()
  if (!area) {
    memoryLinks = memoryLinks ?? []
    return memoryLinks
  }
  const raw = area.getItem(LINK_STORAGE_KEY)
  if (!raw) {
    memoryLinks = []
    return memoryLinks
  }
  try {
    const links = normalizeLinkArray(JSON.parse(raw) as unknown)
    if (links === null) {
      throw new Error('分享链接存储结构不正确')
    }
    memoryLinks = links
    return links
  } catch {
    // 坏数据不能直接覆盖：留一份原始副本，再从空列表开始，页面不因此崩溃。
    try {
      area.setItem(`${LINK_STORAGE_KEY}:corrupt:${Date.now()}`, raw)
    } catch {
      // 存储已满时忽略备份
    }
    memoryLinks = []
    return memoryLinks
  }
}

function readLinks(): ShareLinkRecord[] {
  return clone(readStorageLinks())
}

function writeLinks(links: ShareLinkRecord[]): void {
  memoryLinks = links
  const area = storageArea()
  if (!area) {
    return
  }
  const payload: StoredShareLinks = {
    version: LINK_SCHEMA_VERSION,
    updatedAt: iso(resolveNow()),
    links,
  }
  try {
    area.setItem(LINK_STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    // 存储写不进去时必须让调用方知道，不能假装成功。
    throw error instanceof Error ? error : new Error('分享链接写入失败')
  }
}

function readArchive(): ShareLinkRecord[] {
  const area = storageArea()
  if (!area) {
    memoryArchive = memoryArchive ?? []
    return memoryArchive
  }
  const raw = area.getItem(LINK_ARCHIVE_KEY)
  if (!raw) {
    memoryArchive = []
    return memoryArchive
  }
  try {
    memoryArchive = normalizeLinkArray(JSON.parse(raw) as unknown) ?? []
  } catch {
    memoryArchive = []
  }
  return memoryArchive
}

function writeArchive(archive: ShareLinkRecord[]): void {
  memoryArchive = archive
  const area = storageArea()
  if (!area) {
    return
  }
  try {
    area.setItem(
      LINK_ARCHIVE_KEY,
      JSON.stringify({ version: LINK_SCHEMA_VERSION, archivedAt: iso(resolveNow()), links: archive }),
    )
  } catch {
    // 归档失败不影响主流程
  }
}

function archiveLinks(records: ShareLinkRecord[], reason: string): void {
  if (records.length === 0) {
    return
  }
  const archive = readArchive()
  for (const record of records) {
    archive.push({
      ...clone(record),
      revokedReason: trimText(record.revokedReason)
        ? `${record.revokedReason}；清理归档：${reason}`
        : `清理归档：${reason}`,
    })
  }
  writeArchive(archive)
}

/**
 * 同步读改写事务：每次都从存储重新读取，避免同页多个调用或标签页拿到过期副本。
 * mutator 必须是同步逻辑；返回结果在事务内拷贝出去。
 */
function mutateLinks<T>(mutator: (links: ShareLinkRecord[]) => T): T {
  const links = readStorageLinks()
  const result = mutator(links)
  writeLinks(links)
  return result
}

/** 仅测试用：清掉内存态，下一次调用重新从 localStorage 读取。 */
export function __resetShareMemoryForTests(): void {
  memoryLinks = null
  memoryArchive = null
  clockOverride = null
  __resetLocalStoreCacheForTests()
}

export function shareStorageKey(): string {
  return LINK_STORAGE_KEY
}

// ---------------------------------------------------------------------------
// 分享配置解析
// ---------------------------------------------------------------------------

function dedupeEntries(rows: EntryRow[]): EntryRow[] {
  const seen = new Map<string, EntryRow>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const key = str(row.id)
    if (!seen.has(key)) {
      seen.set(key, row)
    }
  }
  return [...seen.values()]
}

function shareRows(): EntryRow[] {
  return dedupeEntries(listRows('share'))
}

function findShareRow(shareId: number): EntryRow | undefined {
  return shareRows().find((row) => Number(row.id) === Number(shareId))
}

function readConfig(row: EntryRow): ShareConfig {
  const shareId = Number(row.id)
  return {
    shareId,
    linkCode: trimText(row['链接编号']) || `SHAR-${pad(shareId)}`,
    targetDataset: trimText(row['目标数据集']),
    password: str(row['访问密码']),
    validityDays: parseDays(row['有效期天数']),
    maxViews: parsePositiveInt(row['最大浏览次数'], DEFAULT_MAX_VIEWS),
    downloadEnabled: parseFlag(row['下载开关'], false),
    autoCleanup: parseFlag(row['过期自动清理'], false),
    watermarkContent: str(row['水印内容']),
    templateSelector: trimText(row['报告模板编号']) || trimText(row['模板编号']),
  }
}

function resolveDataset(targetDataset: string): {
  datasetId: string
  datasetName: string
  datasetSourceTable: string
} {
  const target = trimText(targetDataset)
  const datasets = listRows('datastore')
  const exact = datasets.find(
    (row) => trimText(row['数据集编号']) === target || trimText(row['数据集名称']) === target,
  )
  const fuzzy =
    exact ||
    datasets.find((row) => {
      const name = trimText(row['数据集名称'])
      return name !== '' && target !== '' && name.includes(target)
    })
  if (!fuzzy) {
    return { datasetId: '', datasetName: target, datasetSourceTable: '' }
  }
  return {
    datasetId: trimText(fuzzy['数据集编号']),
    datasetName: trimText(fuzzy['数据集名称']) || target,
    datasetSourceTable: trimText(fuzzy['来源表名']),
  }
}

function resolveTemplate(config: ShareConfig): EntryRow | undefined {
  const templates = listRows('reportgen')
  if (config.templateSelector) {
    return templates.find(
      (row) =>
        trimText(row['模板编号']) === config.templateSelector ||
        str(row.id) === config.templateSelector,
    )
  }
  const byName = templates.find(
    (row) => config.targetDataset !== '' && trimText(row['模板名称']) === config.targetDataset,
  )
  return (
    byName ||
    templates.find((row) => trimText(row.status) === '已生效' && trimText(row['水印开关']) !== '关闭') ||
    templates.find((row) => trimText(row.status) === '已生效') ||
    templates[0]
  )
}

function buildSnapshot(row: EntryRow, config: ShareConfig, nowMs: number): ShareSnapshot {
  const dataset = resolveDataset(config.targetDataset)
  const template = resolveTemplate(config)
  const snapshot: ShareSnapshot = {
    version: 1,
    capturedAt: iso(nowMs),
    linkCode: config.linkCode,
    shareId: config.shareId,
    targetDataset: config.targetDataset,
    datasetId: dataset.datasetId,
    datasetName: dataset.datasetName,
    datasetSourceTable: dataset.datasetSourceTable,
    templateId: template ? trimText(template['模板编号']) : '',
    templateName: template ? trimText(template['模板名称']) : '',
    templateChartList: template ? trimText(template['包含图表']) : '',
    templatePeriod: template ? trimText(template['报告周期']) : '',
    templateExportFormat: template ? trimText(template['导出格式']) : '',
    templatePushChannel: template ? trimText(template['推送渠道']) : '',
    templateWatermarkEnabled: template ? trimText(template['水印开关']) : '',
    watermarkContent: config.watermarkContent,
    downloadEnabled: config.downloadEnabled,
    checksum: '',
  }
  snapshot.checksum = snapshotChecksum(snapshot)
  return snapshot
}

function snapshotIsUsable(snapshot: ShareSnapshot | null | undefined): boolean {
  return snapshotProblem(snapshot) === null
}

function effectiveStatus(link: ShareLinkRecord, nowMs: number): ShareLinkState {
  if (trimText(link.status) === 'revoked' || trimText(link.revokedAt)) {
    return 'revoked'
  }
  const expires = new Date(link.expiresAt).getTime()
  if (Number.isFinite(expires) && nowMs >= expires) {
    return 'expired'
  }
  if (Number(link.viewCount) >= Number(link.maxViews)) {
    return 'exhausted'
  }
  return 'active'
}

const STATE_LABELS = SHARE_STATE_LABELS

function remainingViews(link: ShareLinkRecord): number {
  return Math.max(0, Number(link.maxViews) - Number(link.viewCount))
}

/**
 * 下载是访问策略而不是快照内容：以分享配置当前开关为准；配置被删掉时退回生成时冻结的值。
 * 这样运营关闭下载后，已发出去的链接立即只能预览。
 */
function downloadAllowed(link: ShareLinkRecord): boolean {
  const row = findShareRow(Number(link.shareId))
  if (row) {
    return parseFlag(row['下载开关'], Boolean(link.downloadEnabled))
  }
  return Boolean(link.downloadEnabled)
}

function summarise(link: ShareLinkRecord, nowMs: number): ShareLinkSummary {
  const { password: _password, ...rest } = link
  const state = effectiveStatus(link, nowMs)
  return {
    ...clone(rest),
    passwordRequired: trimText(link.password) !== '',
    snapshotValid: snapshotProblem(link.snapshot) === null,
    downloadEnabled: downloadAllowed(link),
    effectiveStatus: state,
    remainingViews: remainingViews(link),
    active: state === 'active',
  }
}

function accessFailure(
  link: ShareLinkRecord,
  code: ShareAccessCode,
  message: string,
  options: { nowMs: number; channel: string; status?: ShareLinkState | 'missing' },
): ShareAccessResult {
  return {
    ok: false,
    code,
    message,
    status: options.status ?? effectiveStatus(link, options.nowMs),
    token: link.token,
    channel: options.channel,
    downloadAllowed: false,
    viewCount: Number(link.viewCount),
    maxViews: Number(link.maxViews),
    remainingViews: remainingViews(link),
    firstViewedAt: link.firstViewedAt,
    snapshot: null,
    recorded: false,
    isFirstVisit: false,
  }
}

function makeBatch(
  action: ShareVisitAction,
  channel: string,
  code: ShareAccessCode,
  counted: boolean,
  message: string,
  nowMs: number,
): ShareVisitBatch {
  return {
    id: newBatchId(),
    at: iso(nowMs),
    channel,
    action,
    result: code,
    resultLabel: SHARE_ACCESS_LABELS[code],
    counted,
    message,
  }
}

function appendVisit(link: ShareLinkRecord, batch: ShareVisitBatch): void {
  if (!Array.isArray(link.visits)) {
    link.visits = []
  }
  link.visits.push(batch)
}

function mergeVisits(target: ShareLinkRecord, source: ShareLinkRecord): void {
  const known = new Set((target.visits || []).map((batch) => batch.id))
  for (const batch of source.visits || []) {
    if (batch && batch.id && !known.has(batch.id)) {
      appendVisit(target, batch)
      known.add(batch.id)
    }
  }
}

function syncEntryStatus(shareId: number, status: string, pending: boolean, abnormal: boolean): void {
  const rows = listRows('share')
  const index = rows.findIndex((row) => Number(row.id) === Number(shareId))
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = { ...rows[index], status, pending, abnormal }
  saveRows('share', next)
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export function generateShareLink(
  shareId: number,
  options: ShareGenerateOptions = {},
): ShareGenerateResult {
  const nowMs = resolveNow(options)
  const row = findShareRow(shareId)
  if (!row) {
    return {
      ok: false,
      reused: false,
      link: null,
      message: `没有找到编号为 ${shareId} 的分享链接配置`,
    }
  }
  const config = readConfig(row)

  const outcome = mutateLinks((links) => {
    // 先找仍然有效的旧链接：重复生成只复用，不重新拍快照，也不重置计数与有效期。
    const existing = links
      .filter((link) => Number(link.shareId) === Number(shareId))
      .filter((link) => effectiveStatus(link, nowMs) === 'active')
      .filter((link) => snapshotIsUsable(link.snapshot))
      .sort((left, right) => {
        const leftAt = new Date(left.createdAt).getTime()
        const rightAt = new Date(right.createdAt).getTime()
        return leftAt - rightAt || left.token.localeCompare(right.token)
      })[0]

    if (existing) {
      return { record: existing, reused: true, error: '' }
    }

    if (trimText(config.watermarkContent) === '') {
      return { record: null, reused: false, error: '分享快照缺少水印内容，不能生成链接' }
    }

    const snapshot = buildSnapshot(row, config, nowMs)
    const record: ShareLinkRecord = {
      token: newToken(),
      shareId: config.shareId,
      linkCode: config.linkCode,
      createdAt: iso(nowMs),
      expiresAt: iso(nowMs + config.validityDays * DAY_MS),
      validityDays: config.validityDays,
      maxViews: config.maxViews,
      viewCount: 0,
      password: config.password,
      downloadEnabled: config.downloadEnabled,
      autoCleanup: config.autoCleanup,
      status: 'active',
      revokedAt: null,
      revokedReason: '',
      firstViewedAt: null,
      lastViewedAt: null,
      snapshot,
      visits: [],
    }
    links.push(record)
    return { record, reused: false, error: '' }
  })

  if (!outcome.record) {
    return { ok: false, reused: false, link: null, message: outcome.error || '分享链接生成失败' }
  }

  syncEntryStatus(config.shareId, '已生效', false, false)
  return {
    ok: true,
    reused: outcome.reused,
    link: summarise(outcome.record, nowMs),
    message: outcome.reused
      ? `${config.linkCode} 已存在有效分享链接，直接复用（同一快照、同一计数），未重新生成`
      : `${config.linkCode} 分享链接已生成，水印快照已冻结`,
  }
}

// ---------------------------------------------------------------------------
// 访问
// ---------------------------------------------------------------------------

type InternalAccessOptions = ShareAccessOptions & { action?: ShareVisitAction }

function missingResult(token: string, channel: string): ShareAccessResult {
  return {
    ok: false,
    code: 'NOT_FOUND',
    message: SHARE_ACCESS_LABELS.NOT_FOUND,
    status: 'missing',
    token,
    channel,
    downloadAllowed: false,
    viewCount: 0,
    maxViews: 0,
    remainingViews: 0,
    firstViewedAt: null,
    snapshot: null,
    recorded: false,
    isFirstVisit: false,
  }
}

export function accessShareLink(token: string, options: InternalAccessOptions = {}): ShareAccessResult {
  const action: ShareVisitAction = options.action === 'download' ? 'download' : 'preview'
  const channel = trimText(options.channel) || 'direct'
  const nowMs = resolveNow(options)
  const normalizedToken = trimText(token)
  if (!normalizedToken) {
    return missingResult('', channel)
  }

  return mutateLinks<ShareAccessResult>((links) => {
    const link = links.find((item) => trimText(item.token) === normalizedToken)
    if (!link) {
      return missingResult(normalizedToken, channel)
    }

    // 1. 撤销、过期、次数耗尽先判：链接的可用状态是权威结论，与快照内容无关。
    //    三种原因分别给出明确码，便于运营区分「密码错」与「链接已经不能用了」。
    const state = effectiveStatus(link, nowMs)
    if (state === 'revoked') {
      const message = trimText(link.revokedReason)
        ? `${SHARE_ACCESS_LABELS.REVOKED}：${trimText(link.revokedReason)}`
        : SHARE_ACCESS_LABELS.REVOKED
      link.status = 'revoked'
      appendVisit(link, makeBatch(action, channel, 'REVOKED', false, message, nowMs))
      return accessFailure(link, 'REVOKED', message, { nowMs, channel, status: 'revoked' })
    }
    if (state === 'expired') {
      const message = `分享链接已过期（有效期 ${link.validityDays} 天，截止 ${link.expiresAt}）`
      link.status = 'expired'
      appendVisit(link, makeBatch(action, channel, 'EXPIRED', false, message, nowMs))
      return accessFailure(link, 'EXPIRED', message, { nowMs, channel, status: 'expired' })
    }
    if (state === 'exhausted') {
      const message = `分享链接浏览次数已耗尽（${link.viewCount}/${link.maxViews} 次）`
      link.status = 'exhausted'
      appendVisit(link, makeBatch(action, channel, 'VIEW_LIMIT_REACHED', false, message, nowMs))
      return accessFailure(link, 'VIEW_LIMIT_REACHED', message, { nowMs, channel, status: 'exhausted' })
    }

    // 2. 快照完整性：缺失、水印为空或被改写都不能展示旧页面，也不能消耗次数。
    const problem = snapshotProblem(link.snapshot)
    if (problem) {
      const message = `${SHARE_ACCESS_LABELS.SNAPSHOT_INVALID}，无法展示页面`
      appendVisit(link, makeBatch(action, channel, problem, false, message, nowMs))
      return accessFailure(link, problem, message, { nowMs, channel, status: 'active' })
    }

    // 3. 密码错误与撤销是两类失败，密码失败不计数。
    if (trimText(link.password) !== '' && str(options.password) !== link.password) {
      const message = '访问密码错误，无法打开分享页面'
      appendVisit(link, makeBatch(action, channel, 'BAD_PASSWORD', false, message, nowMs))
      return accessFailure(link, 'BAD_PASSWORD', message, { nowMs, channel, status: 'active' })
    }

    // 4. 下载开关只拦文件请求，页面预览不受影响。
    if (action === 'download' && !downloadAllowed(link)) {
      const message = '该分享已关闭下载，仅支持页面预览'
      appendVisit(link, makeBatch(action, channel, 'DOWNLOAD_DISABLED', false, message, nowMs))
      return accessFailure(link, 'DOWNLOAD_DISABLED', message, { nowMs, channel, status: 'active' })
    }

    // 5. 成功访问：计数、首次访问时间、批次在同一个同步事务里落盘。
    //    JS 单线程下多个「同时」请求会顺序执行；后到的请求读到的 viewCount 已包含前一个成功请求。
    const isFirstVisit = !link.firstViewedAt
    link.viewCount = Number(link.viewCount) + 1
    link.firstViewedAt = link.firstViewedAt || iso(nowMs)
    link.lastViewedAt = iso(nowMs)
    link.status = link.viewCount >= Number(link.maxViews) ? 'exhausted' : 'active'
    const message = action === 'download' ? '分享文件已生成' : '分享页面已打开'
    appendVisit(link, makeBatch(action, channel, 'OK', true, message, nowMs))

    return {
      ok: true,
      code: 'OK',
      message,
      status: link.status,
      token: link.token,
      channel,
      downloadAllowed: downloadAllowed(link),
      viewCount: Number(link.viewCount),
      maxViews: Number(link.maxViews),
      remainingViews: remainingViews(link),
      firstViewedAt: link.firstViewedAt,
      snapshot: clone(link.snapshot),
      file: action === 'download' ? buildDownloadFile(link) : undefined,
      recorded: true,
      isFirstVisit,
    }
  })
}

export function previewShareLink(token: string, options: ShareAccessOptions = {}): ShareAccessResult {
  return accessShareLink(token, { ...options, action: 'preview' })
}

export function downloadShareLink(token: string, options: ShareAccessOptions = {}): ShareAccessResult {
  return accessShareLink(token, { ...options, action: 'download' })
}

/** 跨标签页可用的串行化包装：浏览器支持 Web Locks 时把访问排队，避免两个标签页同时抢最后一个次数。 */
async function withCrossTabLock<T>(name: string, task: () => T): Promise<T> {
  const locks =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { locks?: { request: <R>(name: string, task: () => Promise<R> | R) => Promise<R> } })
          .locks
      : undefined
  if (locks && typeof locks.request === 'function') {
    return locks.request(`interactive-analytics-lab:${name}`, () => task())
  }
  return task()
}

export function previewShareLinkAsync(
  token: string,
  options: ShareAccessOptions = {},
): Promise<ShareAccessResult> {
  return withCrossTabLock('share-access', () => previewShareLink(token, options))
}

export function downloadShareLinkAsync(
  token: string,
  options: ShareAccessOptions = {},
): Promise<ShareAccessResult> {
  return withCrossTabLock('share-access', () => downloadShareLink(token, options))
}

export function generateShareLinkAsync(
  shareId: number,
  options: ShareGenerateOptions = {},
): Promise<ShareGenerateResult> {
  return withCrossTabLock('share-generate', () => generateShareLink(shareId, options))
}

function buildDownloadFile(link: ShareLinkRecord): ShareLinkFile {
  const snapshot = link.snapshot
  const datasetName = snapshot.datasetName || snapshot.targetDataset || '分享数据'
  const filename = `${snapshot.linkCode || 'share'}-${datasetName}.txt`.replace(/[\\/:*?"<>|]/g, '_')
  return {
    filename,
    mimeType: 'text/plain;charset=utf-8',
    content: [
      `水印：${snapshot.watermarkContent}`,
      `链接编号：${snapshot.linkCode}`,
      `目标数据集：${snapshot.targetDataset || '未指定'}`,
      `数据集名称：${datasetName}`,
      `报告模板：${snapshot.templateName || '未绑定模板'}`,
      `包含图表：${snapshot.templateChartList || '未登记'}`,
      `快照生成时间：${snapshot.capturedAt}`,
      `快照校验和：${snapshot.checksum}`,
      `访问时间：${link.lastViewedAt || ''}`,
      `访问批次：${link.viewCount}/${link.maxViews}，首次访问：${link.firstViewedAt || ''}`,
      '',
      '说明：本文件由生成链接时冻结的快照导出，不受后续模板或数据集更新影响。',
    ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

export type ShareRevokeOptions = ShareClockOption & { reason?: string }

export function revokeShareLink(shareId: number, options: ShareRevokeOptions = {}): ShareRevokeResult {
  const nowMs = resolveNow(options)
  const reason = trimText(options.reason) || '运营撤销'
  const outcome = mutateLinks((links) => {
    const records = links.filter((link) => Number(link.shareId) === Number(shareId))
    if (records.length === 0) {
      return { revoked: 0, removed: 0, record: null as ShareLinkRecord | null }
    }
    // 撤销时合并同一分享配置下的重复链接：保留最早一条，其余批次并入后删除，避免残留与重复显示。
    records.sort((left, right) => {
      const leftAt = new Date(left.createdAt).getTime()
      const rightAt = new Date(right.createdAt).getTime()
      return leftAt - rightAt || left.token.localeCompare(right.token)
    })
    const canonical = records[0]
    const duplicates = records.slice(1)
    for (const duplicate of duplicates) {
      mergeVisits(canonical, duplicate)
    }
    canonical.status = 'revoked'
    canonical.revokedAt = iso(nowMs)
    canonical.revokedReason = reason
    if (duplicates.length > 0) {
      const remaining = links.filter((link) => !duplicates.includes(link))
      links.length = 0
      links.push(...remaining)
      archiveLinks(duplicates, `撤销 ${canonical.linkCode} 时合并重复记录`)
    }
    return { revoked: records.length, removed: duplicates.length, record: canonical }
  })

  syncEntryStatus(shareId, '已失效', false, true)
  if (!outcome.record) {
    return { ok: false, revoked: 0, message: `分享配置 ${shareId} 还没有生成过链接，已同步为失效状态` }
  }
  return {
    ok: true,
    revoked: outcome.revoked,
    message: `分享链接已撤销${outcome.removed > 0 ? `，并清理重复记录 ${outcome.removed} 条` : ''}：${reason}`,
  }
}

export function revokeShareLinkByToken(
  token: string,
  options: ShareRevokeOptions = {},
): ShareRevokeResult {
  const normalized = trimText(token)
  const found = readLinks().find((link) => trimText(link.token) === normalized)
  if (!found) {
    return { ok: false, revoked: 0, message: `没有找到令牌为 ${token} 的分享链接` }
  }
  return revokeShareLink(Number(found.shareId), {
    ...options,
    reason: trimText(options.reason) || '按链接撤销',
  })
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function listShareEntries(): EntryRow[] {
  return shareRows()
}

export function listShareLinks(options: ShareListOptions = {}): ShareLinkSummary[] {
  const nowMs = resolveNow(options)
  const keyword = trimText(options.keyword).toLowerCase()
  return readLinks()
    .filter((link) =>
      options.shareId === undefined ? true : Number(link.shareId) === Number(options.shareId),
    )
    .filter((link) =>
      options.includeRevoked === false ? effectiveStatus(link, nowMs) !== 'revoked' : true,
    )
    .filter((link) => {
      if (!keyword) {
        return true
      }
      return [
        link.linkCode,
        link.token,
        link.snapshot?.targetDataset,
        link.snapshot?.datasetName,
        link.snapshot?.templateName,
        link.snapshot?.watermarkContent,
      ]
        .map((item) => str(item).toLowerCase())
        .some((item) => item.includes(keyword))
    })
    .sort((left, right) => {
      const byShare = Number(left.shareId) - Number(right.shareId)
      return byShare !== 0
        ? byShare
        : new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    })
    .map((link) => summarise(link, nowMs))
}

export function getShareLink(
  token: string,
  options: ShareClockOption = {},
): ShareLinkSummary | null {
  const normalized = trimText(token)
  const link = readLinks().find((item) => trimText(item.token) === normalized)
  return link ? summarise(link, resolveNow(options)) : null
}

export function getShareVisits(token: string): ShareVisitBatch[] {
  const normalized = trimText(token)
  const link = readLinks().find((item) => trimText(item.token) === normalized)
  return link && Array.isArray(link.visits) ? clone(link.visits) : []
}

export function getShareStats(options: ShareClockOption = {}): ShareStats {
  const nowMs = resolveNow(options)
  const links = readLinks()
  const entries = shareRows()
  return {
    total: links.length,
    active: links.filter((link) => effectiveStatus(link, nowMs) === 'active').length,
    pending: entries.filter((row) => ['草稿', '待生成'].includes(trimText(row.status))).length,
  }
}

/**
 * 管理端自检：只看状态，不写访问批次、不消耗浏览次数。
 * 用于定位「点不动」「显示旧页面」：能区分快照缺失、密码要求、撤销与过期。
 */
export function inspectShareLink(
  token: string,
  options: ShareClockOption = {},
): ShareLinkInspection {
  const nowMs = resolveNow(options)
  const normalized = trimText(token)
  const empty: ShareLinkInspection = {
    ok: false,
    message: SHARE_ACCESS_LABELS.NOT_FOUND,
    link: null,
    snapshot: null,
    problem: 'NOT_FOUND',
    downloadAllowed: false,
    visits: [],
    stateLabel: '不存在',
  }
  if (!normalized) {
    return empty
  }
  const link = readLinks().find((item) => trimText(item.token) === normalized)
  if (!link) {
    return empty
  }
  const problem = snapshotProblem(link.snapshot)
  const state = problem ? null : effectiveStatus(link, nowMs)
  const summary = summarise(link, nowMs)
  let message: string
  if (problem) {
    message = SHARE_ACCESS_LABELS[problem]
  } else if (state === 'active') {
    message = trimText(link.password)
      ? '链接可用，访问需要密码；页面预览不消耗次数直到密码正确'
      : '链接可用，可直接打开页面'
  } else {
    message = SHARE_ACCESS_LABELS[state === 'revoked' ? 'REVOKED' : state === 'expired' ? 'EXPIRED' : 'VIEW_LIMIT_REACHED']
  }
  return {
    ok: !problem && state === 'active',
    message,
    link: summary,
    snapshot: link.snapshot ? clone(link.snapshot) : null,
    problem,
    downloadAllowed: downloadAllowed(link),
    visits: Array.isArray(link.visits) ? clone(link.visits) : [],
    stateLabel: state ? STATE_LABELS[state] : '快照异常',
  }
}

export function shareStateLabel(state: ShareLinkState): string {
  return STATE_LABELS[state] ?? state
}

export function shareAccessLabel(code: ShareAccessCode): string {
  return SHARE_ACCESS_LABELS[code] ?? code
}

// ---------------------------------------------------------------------------
// 诊断与清理
// ---------------------------------------------------------------------------

export function diagnoseShareData(options: ShareClockOption = {}): ShareDiagnosis {
  const nowMs = resolveNow(options)
  const rawEntries = listRows('share')
  const entries = dedupeEntries(rawEntries)
  const entryIds = new Set(entries.map((row) => str(row.id)))
  const links = readLinks()
  const issues: ShareIssue[] = []

  const push = (
    code: ShareIssue['code'],
    severity: ShareIssue['severity'],
    shareId: number | null,
    token: string,
    message: string,
  ): void => {
    issues.push({ code, severity, shareId, token, message })
  }

  if (rawEntries.length !== entries.length) {
    push('DUPLICATE_ENTRY', 'warning', null, '', `分享配置存在重复记录 ${rawEntries.length - entries.length} 条`)
  }

  const tokenCounts = new Map<string, number>()
  const activeByShare = new Map<string, ShareLinkRecord[]>()

  for (const link of links) {
    const token = trimText(link.token)
    if (!token) {
      push('MISSING_TOKEN', 'error', Number(link.shareId) || null, '', `分享配置 ${str(link.shareId)} 的链接缺少令牌，页面无法打开`)
    } else {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
    }

    if (!entryIds.has(str(link.shareId))) {
      push('ORPHAN_LINK', 'warning', Number(link.shareId) || null, token, `链接 ${token} 对应的分享配置已不存在`)
    }

    if (!link.snapshot) {
      push('MISSING_SNAPSHOT', 'error', Number(link.shareId) || null, token, `链接 ${token} 缺少不可变快照`)
    } else {
      if (trimText(link.snapshot.watermarkContent) === '') {
        push('MISSING_WATERMARK', 'error', Number(link.shareId) || null, token, `链接 ${token} 的快照缺少水印内容`)
      }
      if (link.snapshot.checksum && snapshotChecksum(link.snapshot) !== link.snapshot.checksum) {
        push('SNAPSHOT_CHECKSUM_MISMATCH', 'error', Number(link.shareId) || null, token, `链接 ${token} 的快照校验失败，可能被改写`)
      }
    }

    const state = effectiveStatus(link, nowMs)
    if (trimText(link.status) !== state) {
      push('STALE_STATUS', 'info', Number(link.shareId) || null, token, `链接 ${token} 状态「${link.status}」与当前「${state}」不一致`)
    }

    const seenBatchIds = new Set<string>()
    for (const batch of link.visits || []) {
      if (!batch || typeof batch !== 'object' || !batch.id || seenBatchIds.has(batch.id)) {
        push('INVALID_VISIT_BATCH', 'warning', Number(link.shareId) || null, token, `链接 ${token} 的访问批次缺失编号或编号重复`)
        continue
      }
      seenBatchIds.add(batch.id)
      if (!SHARE_ACCESS_LABELS[batch.result]) {
        push('INVALID_VISIT_BATCH', 'warning', Number(link.shareId) || null, token, `链接 ${token} 的访问批次结果「${str(batch.result)}」无法识别`)
      }
      if (batch.counted && batch.result !== 'OK') {
        push('INVALID_VISIT_BATCH', 'warning', Number(link.shareId) || null, token, `链接 ${token} 的失败访问被错误计次`)
      }
    }

    if (state === 'active') {
      const group = activeByShare.get(str(link.shareId)) ?? []
      group.push(link)
      activeByShare.set(str(link.shareId), group)
    }
  }

  for (const [shareId, group] of activeByShare) {
    if (group.length > 1) {
      push('DUPLICATE_ACTIVE_LINK', 'warning', Number(shareId) || null, group.map((link) => link.token).join(','), `分享配置 ${shareId} 有 ${group.length} 条同时有效的链接，显示会重复`)
    }
  }

  for (const [token, count] of tokenCounts) {
    if (count > 1) {
      push('DUPLICATE_TOKEN', 'warning', null, token, `令牌 ${token} 在存储里出现了 ${count} 次，访问可能命中旧记录`)
    }
  }

  for (const row of entries) {
    const shareId = Number(row.id)
    const config = readConfig(row)
    const active = (activeByShare.get(str(row.id)) ?? []).length > 0
    if (trimText(config.watermarkContent) === '' && (trimText(row.status) === '已生效' || active)) {
      push('INVALID_CONFIG', 'error', shareId, '', `分享配置 ${shareId} 缺少水印内容，不能继续生成链接`)
    }
    if (trimText(row.status) === '已生效' && !active) {
      push('ACTIVE_WITHOUT_LINK', 'error', shareId, '', `分享配置 ${shareId} 标记为已生效，但没有可用链接`)
    }
  }

  return { issues, linkCount: links.length, entryCount: entries.length }
}

export type ShareCleanupOptions = ShareClockOption & {
  removeOrphans?: boolean
  purgeAutoCleanup?: boolean
}

export function cleanupShareData(options: ShareCleanupOptions = {}): ShareCleanupResult {
  const nowMs = resolveNow(options)
  const messages: string[] = []
  let deduped = 0
  let removed = 0
  let orphans = 0
  let repaired = 0

  // 1. 分享配置行去重：同 id 或同链接编号只保留最早一条。
  const rawEntries = listRows('share')
  const seenIds = new Set<string>()
  const seenCodes = new Set<string>()
  const entries: EntryRow[] = []
  for (const row of rawEntries) {
    const id = str(row.id)
    const code = trimText(row['链接编号'])
    if (seenIds.has(id) || (code !== '' && seenCodes.has(code))) {
      deduped += 1
      continue
    }
    seenIds.add(id)
    if (code !== '') {
      seenCodes.add(code)
    }
    entries.push(row)
  }
  if (entries.length !== rawEntries.length) {
    saveRows('share', entries)
    messages.push(`清理重复分享配置 ${rawEntries.length - entries.length} 条`)
  }
  const entryIds = new Set(entries.map((row) => str(row.id)))

  const outcome = mutateLinks((links) => {
    const toDrop: ShareLinkRecord[] = []

    // 2. 令牌重复：保留最早记录并合并批次；否则同一令牌可能命中旧快照。
    const byToken = new Map<string, ShareLinkRecord[]>()
    for (const link of links) {
      const token = trimText(link.token)
      if (!token) {
        continue
      }
      const group = byToken.get(token) ?? []
      group.push(link)
      byToken.set(token, group)
    }
    for (const group of byToken.values()) {
      if (group.length <= 1) {
        continue
      }
      group.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
      const canonical = group[0]
      for (const duplicate of group.slice(1)) {
        mergeVisits(canonical, duplicate)
        toDrop.push(duplicate)
        deduped += 1
      }
    }

    // 3. 同一分享配置的多条有效链接：保留最早一条，合并访问批次与已计次数。
    const activeByShare = new Map<string, ShareLinkRecord>()
    for (const link of links) {
      if (toDrop.includes(link) || effectiveStatus(link, nowMs) !== 'active') {
        continue
      }
      const key = str(link.shareId)
      const current = activeByShare.get(key)
      if (!current) {
        activeByShare.set(key, link)
        continue
      }
      const currentAt = new Date(current.createdAt).getTime()
      const linkAt = new Date(link.createdAt).getTime()
      const older = linkAt < currentAt ? link : current
      const newer = older === link ? current : link
      mergeVisits(older, newer)
      older.viewCount = Math.min(
        Number(older.maxViews),
        Number(older.viewCount) + Number(newer.viewCount),
      )
      const olderLast = new Date(str(older.lastViewedAt)).getTime()
      const newerLast = new Date(str(newer.lastViewedAt)).getTime()
      if (Number.isFinite(newerLast) && (!Number.isFinite(olderLast) || newerLast > olderLast)) {
        older.lastViewedAt = newer.lastViewedAt
      }
      activeByShare.set(key, older)
      toDrop.push(newer)
      deduped += 1
    }

    // 4. 孤儿链接、坏令牌、坏快照、坏批次与状态漂移。
    for (const link of links) {
      if (toDrop.includes(link)) {
        continue
      }
      if (!entryIds.has(str(link.shareId))) {
        if (options.removeOrphans !== false) {
          orphans += 1
          toDrop.push(link)
          continue
        }
      }
      if (!trimText(link.token)) {
        link.token = newToken()
        repaired += 1
        messages.push(`为分享配置 ${str(link.shareId)} 补发缺失的链接令牌`)
      }
      if (snapshotProblem(link.snapshot)) {
        link.status = 'revoked'
        link.revokedAt = link.revokedAt || iso(nowMs)
        link.revokedReason = '快照缺失、水印缺失或校验失败，已停用'
        repaired += 1
        messages.push(`分享配置 ${str(link.shareId)} 的链接 ${link.token} 快照无效，已停用`)
      }
      if (!Array.isArray(link.visits)) {
        link.visits = []
        repaired += 1
      } else {
        const seenBatchIds = new Set<string>()
        let changed = false
        const valid: ShareVisitBatch[] = []
        for (const batch of link.visits) {
          if (!batch || typeof batch !== 'object' || !batch.id || seenBatchIds.has(batch.id)) {
            changed = true
            continue
          }
          seenBatchIds.add(batch.id)
          const normalized: ShareVisitBatch = {
            ...batch,
            channel: trimText(batch.channel) || 'unknown',
            resultLabel: SHARE_ACCESS_LABELS[batch.result] ?? SHARE_ACCESS_LABELS.NOT_FOUND,
            counted: Boolean(batch.counted && batch.result === 'OK'),
          }
          if (normalized.counted !== batch.counted || normalized.resultLabel !== batch.resultLabel) {
            changed = true
          }
          valid.push(normalized)
        }
        if (changed) {
          link.visits = valid
          repaired += 1
          messages.push(`修复分享配置 ${str(link.shareId)} 的访问批次记录`)
        }
      }
      const state = effectiveStatus(link, nowMs)
      if (trimText(link.status) !== state) {
        link.status = state
        repaired += 1
      }
      if (
        options.purgeAutoCleanup !== false &&
        link.autoCleanup &&
        (state === 'expired' || state === 'exhausted')
      ) {
        toDrop.push(link)
        removed += 1
        messages.push(`按过期自动清理移除链接 ${link.token}`)
      }
    }

    if (toDrop.length > 0) {
      archiveLinks(toDrop, '清理重复、孤儿或自动过期记录')
      const remaining = links.filter((link) => !toDrop.includes(link))
      links.length = 0
      links.push(...remaining)
    }
    return { links }
  })

  // 5. 回写分享配置状态，避免入口显示与链接实际状态对不上。
  const finalLinks = outcome.links
  let entryRepaired = 0
  const nextEntries = entries.map((row) => {
    const shareId = Number(row.id)
    const own = finalLinks.filter((link) => Number(link.shareId) === shareId)
    const hasActive = own.some((link) => effectiveStatus(link, nowMs) === 'active')
    const hasRevoked = own.some((link) => effectiveStatus(link, nowMs) === 'revoked')
    let status = trimText(row.status)
    let pending = Boolean(row.pending)
    let abnormal = Boolean(row.abnormal)
    if (hasActive) {
      status = '已生效'
      pending = false
      abnormal = false
    } else if (hasRevoked) {
      status = '已失效'
      pending = false
      abnormal = true
    } else if (status === '已生效') {
      status = '待生成'
      pending = true
      abnormal = false
    }
    if (status !== row.status || pending !== row.pending || abnormal !== row.abnormal) {
      entryRepaired += 1
    }
    return { ...row, status, pending, abnormal }
  })
  if (entryRepaired > 0) {
    saveRows('share', nextEntries)
    messages.push(`同步分享配置状态 ${entryRepaired} 条`)
  }

  const cleanedUi = clearShareUiCache()
  if (cleanedUi > 0) {
    messages.push(`清理页面残留预览状态 ${cleanedUi} 项`)
  }

  return {
    removed,
    deduped,
    orphans,
    repaired: repaired + entryRepaired,
    messages,
  }
}

function clearShareUiCache(): number {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return 0
  }
  try {
    const keys: string[] = []
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index)
      if (key && SHARE_UI_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        keys.push(key)
      }
    }
    for (const key of keys) {
      window.sessionStorage.removeItem(key)
    }
    return keys.length
  } catch {
    return 0
  }
}

/** 彻底清掉分享链接存储（含历史归档与旧版本键），用于重置模块或测试隔离。 */
export function clearShareLinks(): void {
  memoryLinks = []
  memoryArchive = null
  const area = storageArea()
  if (area) {
    try {
      area.removeItem(LINK_STORAGE_KEY)
      area.removeItem(LINK_ARCHIVE_KEY)
      for (const key of LEGACY_LINK_KEYS) {
        area.removeItem(key)
      }
    } catch {
      // 存储不可用时内存态已清空
    }
  }
  clearShareUiCache()
}

export function resetShareModule(): void {
  clearShareLinks()
  resetRows('share')
}

// ---------------------------------------------------------------------------
// 登记分享配置
// ---------------------------------------------------------------------------

export type CreateShareEntryInput = {
  targetDataset: string
  password?: string
  validityDays?: string | number
  maxViews?: string | number
  downloadEnabled?: boolean | string
  watermarkContent?: string
  autoCleanup?: boolean | string
  templateId?: string
  linkCode?: string
}

/** 登记一条分享配置（草稿态）；水印为空时允许保存，但生成链接会被拒绝。 */
export function createShareEntry(input: CreateShareEntryInput): {
  ok: boolean
  message: string
  id: number
  row: EntryRow | null
} {
  const targetDataset = trimText(input.targetDataset)
  if (targetDataset === '') {
    return { ok: false, message: '目标数据集不能为空', id: 0, row: null }
  }
  const rows = listRows('share')
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const linkCode = trimText(input.linkCode) || `SHAR-${pad(nextId)}`
  const row: EntryRow = {
    id: nextId,
    status: '草稿',
    pending: true,
    abnormal: false,
    链接编号: linkCode,
    目标数据集: targetDataset,
    访问密码: str(input.password ?? ''),
    '有效期天数':
      input.validityDays === undefined || input.validityDays === ''
        ? DEFAULT_VALIDITY_DAYS
        : input.validityDays,
    '最大浏览次数':
      input.maxViews === undefined || input.maxViews === ''
        ? DEFAULT_MAX_VIEWS
        : input.maxViews,
    下载开关: parseFlag(input.downloadEnabled, false) ? '开启' : '关闭',
    '水印内容': str(input.watermarkContent ?? ''),
    过期自动清理: parseFlag(input.autoCleanup, false) ? '开启' : '关闭',
  }
  if (trimText(input.templateId)) {
    row['报告模板编号'] = trimText(input.templateId)
  }
  saveRows('share', [...rows, row])
  return {
    ok: true,
    message: trimText(row['水印内容'])
      ? `分享配置 ${linkCode} 已登记`
      : `分享配置 ${linkCode} 已登记，但水印内容为空，不能生成分享链接`,
    id: nextId,
    row,
  }
}

// ---------------------------------------------------------------------------
// 兼容别名：页面或脚本可以用更短的名字调用同一套实现。
// ---------------------------------------------------------------------------

export const createShareLink = generateShareLink
export const accessShare = accessShareLink
export const revokeShare = revokeShareLink
export const listShareLinkSummaries = listShareLinks
export const listVisitBatches = getShareVisits
export const diagnoseShareLinks = diagnoseShareData
export const cleanupShareLinks = cleanupShareData
export const resetShareLinks = resetShareModule
export const shareStats = getShareStats
