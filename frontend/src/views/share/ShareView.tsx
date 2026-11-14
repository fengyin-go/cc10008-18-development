import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'

import {
  cleanupShareData,
  createShareEntry,
  diagnoseShareData,
  generateShareLink,
  getShareStats,
  getShareVisits,
  listShareLinks,
  revokeShareLink,
} from '@/api/share-service'
import { listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type {
  ShareCleanupResult,
  ShareDiagnosis,
  ShareLinkSummary,
  ShareStats,
  ShareVisitBatch,
} from '@/data/share-types'
import { SHARE_STATE_LABELS } from '@/data/share-types'

const meta = moduleMeta('share')
const columns = [
  '链接编号',
  '目标数据集',
  '访问密码',
  '有效期天数',
  '最大浏览次数',
  '下载开关',
  '水印内容',
  '过期自动清理',
]
const actions = ['提交生成', '生效分享', '撤销链接']
const statuses = ['草稿', '待生成', '已生效', '已失效']

function formatTime(value: string | null): string {
  if (!value) {
    return '—'
  }
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : value
}

function maskPassword(value: unknown): string {
  const text = String(value ?? '')
  return text === '' ? '无需密码' : '••••••'
}

export default function ShareView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [links, setLinks] = useState<ShareLinkSummary[]>([])
  const [stats, setStats] = useState<ShareStats>({ total: 0, active: 0, pending: 0 })
  const [diagnosis, setDiagnosis] = useState<ShareDiagnosis | null>(null)
  const [lastCleanup, setLastCleanup] = useState<ShareCleanupResult | null>(null)
  const [selectedToken, setSelectedToken] = useState('')
  const [visits, setVisits] = useState<ShareVisitBatch[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [noticeMessage, setNoticeMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [form, setForm] = useState({
    targetDataset: '',
    password: '',
    validityDays: '30',
    maxViews: '10',
    downloadEnabled: false,
    watermarkContent: '',
    autoCleanup: false,
  })
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setLinks(listShareLinks())
      setStats(getShareStats())
      setDiagnosis(diagnoseShareData())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据分享列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (!selectedToken) {
      setVisits([])
      return
    }
    setVisits(getShareVisits(selectedToken))
  }, [selectedToken, links])

  function generate(row: EntryRow) {
    setErrorMessage('')
    setNoticeMessage('')
    const result = generateShareLink(Number(row.id))
    if (!result.ok) {
      setErrorMessage(result.message)
      reload()
      return
    }
    setNoticeMessage(result.message)
    if (result.link) {
      setSelectedToken(result.link.token)
    }
    reload()
  }

  function revoke(row: EntryRow) {
    setErrorMessage('')
    setNoticeMessage('')
    const result = revokeShareLink(Number(row.id))
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setNoticeMessage(result.message)
    }
    reload()
  }

  function runAction(action: string, row: EntryRow) {
    if (action === '撤销链接') {
      revoke(row)
      return
    }
    if (action === '生效分享') {
      generate(row)
      return
    }
    // 「提交生成」只推进配置状态，不生成链接；生成链接仍要显式点「生成/复用链接」。
    setErrorMessage('')
    setNoticeMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNoticeMessage(result.message)
    reload()
  }

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage('')
    setNoticeMessage('')
    const result = createShareEntry(form)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNoticeMessage(result.message)
    setForm((prev) => ({ ...prev, targetDataset: '', watermarkContent: '' }))
    reload()
  }

  function runCleanup() {
    setErrorMessage('')
    setNoticeMessage('')
    const result = cleanupShareData()
    setLastCleanup(result)
    setNoticeMessage(
      result.messages.length > 0
        ? result.messages.join('；')
        : '没有发现需要清理的重复、残留或失效记录',
    )
    reload()
  }

  const selectedLink = links.find((link) => link.token === selectedToken) ?? null

  return (
    <section className="page" data-module="share">
      <header className="page-head">
        <div>
          <h2>数据分享管理</h2>
          <p className="page-desc">
            分享链接在生成时冻结一份水印快照，记录首次访问与访问批次；有效期或次数到限后返回明确失效结果。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={reload}>
            刷新
          </button>
          <button className="btn" type="button" onClick={runCleanup}>
            清理残留与重复记录
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">分享链接总数</span>
          <strong className="stat-value">{stats.total}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已生效链接</span>
          <strong className="stat-value">{stats.active}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待生成配置</span>
          <strong className="stat-value">{stats.pending}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">诊断问题</span>
          <strong className="stat-value">{diagnosis?.issues.length ?? 0}</strong>
        </article>
      </div>

      <p className="status-legend">
        {statuses.map((status) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <article className="panel">
        <h3>登记分享链接</h3>
        <form className="filter-bar" onSubmit={submitCreate}>
          <label className="filter-item">
            <span>目标数据集（必填）</span>
            <input
              value={form.targetDataset}
              placeholder="数据集编号或名称"
              onChange={(event) => setForm((prev) => ({ ...prev, targetDataset: event.target.value }))}
            />
          </label>
          <label className="filter-item">
            <span>水印内容（为空不能生成链接）</span>
            <input
              value={form.watermarkContent}
              placeholder="例如：客户 A 专供，禁止外传"
              onChange={(event) => setForm((prev) => ({ ...prev, watermarkContent: event.target.value }))}
            />
          </label>
          <label className="filter-item">
            <span>访问密码（留空则免密）</span>
            <input
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
            />
          </label>
          <label className="filter-item">
            <span>有效期天数</span>
            <input
              value={form.validityDays}
              onChange={(event) => setForm((prev) => ({ ...prev, validityDays: event.target.value }))}
            />
          </label>
          <label className="filter-item">
            <span>最大浏览次数</span>
            <input
              value={form.maxViews}
              onChange={(event) => setForm((prev) => ({ ...prev, maxViews: event.target.value }))}
            />
          </label>
          <label className="filter-item checkbox-item">
            <span>允许下载</span>
            <input
              type="checkbox"
              checked={form.downloadEnabled}
              onChange={(event) => setForm((prev) => ({ ...prev, downloadEnabled: event.target.checked }))}
            />
          </label>
          <label className="filter-item checkbox-item">
            <span>过期自动清理</span>
            <input
              type="checkbox"
              checked={form.autoCleanup}
              onChange={(event) => setForm((prev) => ({ ...prev, autoCleanup: event.target.checked }))}
            />
          </label>
          <button className="btn primary" type="submit">登记配置</button>
        </form>
        <p className="hint-text">
          登记只写入分享配置；生成链接时才会冻结快照。水印为空时保存成功，但生成会被拒绝。
        </p>
      </article>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
            <th>链接</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const own = links.filter((link) => Number(link.shareId) === Number(row.id))
            const active = own.find((link) => link.effectiveStatus === 'active') ?? own[0] ?? null
            return (
              <tr key={String(row.id)}>
                {columns.map((column) => (
                  <td key={column}>
                    {column === '访问密码' ? maskPassword(row[column]) : row[column] ?? '—'}
                  </td>
                ))}
                <td>{row.status}</td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                  <button className="link" type="button" onClick={() => generate(row)}>
                    生成/复用链接
                  </button>
                </td>
                <td>
                  {active ? (
                    <div className="link-cell">
                      <Link to={`/share/open/${active.token}?channel=站内链接`} className="link">
                        {active.token.slice(0, 14)}…
                      </Link>
                      <span className="hint-text">
                        {SHARE_STATE_LABELS[active.effectiveStatus]} · {active.viewCount}/{active.maxViews}
                      </span>
                      <button className="link" type="button" onClick={() => setSelectedToken(active.token)}>
                        访问批次
                      </button>
                    </div>
                  ) : (
                    <span className="hint-text">尚未生成</span>
                  )}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 3}>暂无数据分享数据，可先登记分享链接</td>
            </tr>
          )}
        </tbody>
      </table>

      <article className="panel">
        <h3>分享链接与快照</h3>
        {links.length === 0 && <p className="hint-text">还没有生成过分享链接。</p>}
        {links.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>链接令牌</th>
                <th>目标数据集</th>
                <th>报告模板（快照）</th>
                <th>水印（快照）</th>
                <th>状态</th>
                <th>访问</th>
                <th>首次/最近访问</th>
                <th>有效期至</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.token} className={link.token === selectedToken ? 'row-selected' : ''}>
                  <td><code>{link.token}</code></td>
                  <td>{link.snapshot?.targetDataset || '—'}</td>
                  <td>{link.snapshot?.templateName || '—'}</td>
                  <td>{link.snapshot?.watermarkContent || '—'}</td>
                  <td>
                    {SHARE_STATE_LABELS[link.effectiveStatus]}
                    {!link.snapshotValid && <span className="error-text"> · 快照异常</span>}
                  </td>
                  <td>{link.viewCount}/{link.maxViews}（剩余 {link.remainingViews}）</td>
                  <td>{formatTime(link.firstViewedAt)} / {formatTime(link.lastViewedAt)}</td>
                  <td>{formatTime(link.expiresAt)}</td>
                  <td className="row-actions">
                    <button className="link" type="button" onClick={() => setSelectedToken(link.token)}>
                      访问批次
                    </button>
                    <Link className="link" to={`/share/open/${link.token}?channel=站内链接`}>
                      打开页面
                    </Link>
                    {link.effectiveStatus === 'active' && (
                      <button
                        className="link"
                        type="button"
                        onClick={() => {
                          revokeShareLink(link.shareId)
                          reload()
                        }}
                      >
                        撤销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>

      {selectedLink && (
        <article className="panel">
          <h3>
            访问批次：<code>{selectedLink.token}</code>
          </h3>
          <p className="hint-text">
            密码错误、次数耗尽等失败访问也留痕，但不计入浏览次数。首次访问 {formatTime(selectedLink.firstViewedAt)}。
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>来源渠道</th>
                <th>动作</th>
                <th>访问结果</th>
                <th>是否计次</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((batch) => (
                <tr key={batch.id}>
                  <td>{formatTime(batch.at)}</td>
                  <td>{batch.channel}</td>
                  <td>{batch.action === 'download' ? '下载' : '预览'}</td>
                  <td>{batch.resultLabel}</td>
                  <td>{batch.counted ? '计次' : '未计次'}</td>
                </tr>
              ))}
              {visits.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={5}>这条链接还没有访问批次</td>
                </tr>
              )}
            </tbody>
          </table>
        </article>
      )}

      <article className="panel">
        <h3>自检与诊断</h3>
        {diagnosis && diagnosis.issues.length === 0 && (
          <p className="hint-text">没有发现问题：{diagnosis.linkCount} 条链接、{diagnosis.entryCount} 条分享配置状态一致。</p>
        )}
        {diagnosis && diagnosis.issues.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>级别</th>
                <th>类型</th>
                <th>分享配置</th>
                <th>令牌</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {diagnosis.issues.map((issue, index) => (
                <tr key={`${issue.code}-${issue.token}-${index}`}>
                  <td>{issue.severity}</td>
                  <td>{issue.code}</td>
                  <td>{issue.shareId ?? '—'}</td>
                  <td><code>{issue.token || '—'}</code></td>
                  <td>{issue.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {lastCleanup && (
          <p className="hint-text">
            上次清理：移除 {lastCleanup.removed} 条、去重 {lastCleanup.deduped} 条、孤儿 {lastCleanup.orphans} 条、修复 {lastCleanup.repaired} 条。
          </p>
        )}
      </article>

      <footer className="page-foot">
        <span>共 {rows.length} 条分享配置、{links.length} 条链接</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
        {!errorMessage && noticeMessage && <span className="notice-text">{noticeMessage}</span>}
      </footer>
    </section>
  )
}
