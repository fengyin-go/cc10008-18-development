import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import {
  downloadShareLinkAsync,
  getShareLink,
  previewShareLinkAsync,
} from '@/api/share-service'
import type { ShareAccessResult, ShareLinkSummary } from '@/data/share-types'

function formatTime(value: string | null): string {
  if (!value) {
    return '—'
  }
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : value
}

/**
 * 分享打开页：真实链接是 /share/open/:token，渠道通过查询串传入。
 * 页面只负责调用 share-service，不在组件里做业务判断。
 * 快照内容只有访问成功之后才渲染：密码、次数、撤销都要先通过服务校验。
 */
export default function ShareOpenView() {
  const params = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const token = params.token ?? ''
  const channel = searchParams.get('channel') ?? '站内链接'

  const [summary, setSummary] = useState<ShareLinkSummary | null>(null)
  const [result, setResult] = useState<ShareAccessResult | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshMeta = useCallback(() => {
    setSummary(getShareLink(token))
  }, [token])

  useEffect(() => {
    refreshMeta()
  }, [refreshMeta])

  const canTryOpen = Boolean(summary && summary.effectiveStatus === 'active')
  const requiresPassword = Boolean(summary && summary.passwordRequired && canTryOpen)

  async function runAccess(kind: 'preview' | 'download') {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      const payload =
        kind === 'download'
          ? await downloadShareLinkAsync(token, { password, channel })
          : await previewShareLinkAsync(token, { password, channel })
      setResult(payload)
      if (payload.ok && payload.file) {
        const blob = new Blob([payload.file.content], { type: payload.file.mimeType })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = payload.file.filename
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        URL.revokeObjectURL(url)
      }
      refreshMeta()
    } finally {
      setBusy(false)
    }
  }

  const snapshot = result?.ok ? result.snapshot : null
  const downOpen = Boolean(summary?.downloadEnabled && canTryOpen)
  const failed = result !== null && !result.ok

  const stateHint = useMemo(() => {
    if (!summary) {
      return ''
    }
    if (summary.effectiveStatus === 'revoked') {
      return '该分享链接已被撤销，无法继续访问。'
    }
    if (summary.effectiveStatus === 'expired') {
      return '该分享链接已超过有效期，无法继续访问。'
    }
    if (summary.effectiveStatus === 'exhausted') {
      return '该分享链接的浏览次数已用完，无法继续访问。'
    }
    return ''
  }, [summary])

  return (
    <section className="page" data-module="share-open">
      <header className="page-head">
        <div>
          <h2>分享页面</h2>
          <p className="page-desc">
            链接 <code>{token || '未提供'}</code>，来源渠道 {channel}。页面内容来自生成链接时冻结的快照。
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/share">返回数据分享管理</Link>
        </div>
      </header>

      {!summary && (
        <p className="notice error-text">链接不存在或已被清理，请联系分享人重新生成。</p>
      )}

      {summary && (
        <div className="stat-row">
          <article className="stat-card">
            <span className="stat-label">链接状态</span>
            <strong className="stat-value small">{summary.effectiveStatus}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">访问次数</span>
            <strong className="stat-value">{summary.viewCount}/{summary.maxViews}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">首次访问</span>
            <strong className="stat-value small">{formatTime(summary.firstViewedAt)}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">有效期至</span>
            <strong className="stat-value small">{formatTime(summary.expiresAt)}</strong>
          </article>
        </div>
      )}

      {stateHint && <p className="notice error-text">{stateHint}</p>}

      {requiresPassword && (
        <form
          className="filter-bar"
          onSubmit={(event) => {
            event.preventDefault()
            void runAccess('preview')
          }}
        >
          <label className="filter-item">
            <span>访问密码</span>
            <input
              type="password"
              value={password}
              placeholder="请输入分享人提供的密码"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="btn primary" type="submit" disabled={busy || !canTryOpen}>
            {busy ? '校验中…' : '打开页面'}
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void runAccess('download')}
            disabled={busy || !canTryOpen || !downOpen}
            title={downOpen ? '' : '该分享已关闭下载'}
          >
            下载文件
          </button>
          <span className="hint-text">下载开关：{downOpen ? '开启' : '关闭'}</span>
        </form>
      )}

      {summary && !requiresPassword && (
        <div className="filter-bar">
          <button className="btn primary" type="button" onClick={() => void runAccess('preview')} disabled={busy || !canTryOpen}>
            {busy ? '处理中…' : '打开页面'}
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void runAccess('download')}
            disabled={busy || !canTryOpen || !downOpen}
            title={downOpen ? '' : '该分享已关闭下载'}
          >
            下载文件
          </button>
          <span className="hint-text">下载开关：{downOpen ? '开启' : '关闭'}</span>
        </div>
      )}

      {failed && result && (
        <p className="notice error-text" data-failure-code={result.code}>
          <strong>{result.code === 'BAD_PASSWORD' ? '访问密码错误' : '访问失败'}</strong>：{result.message}
        </p>
      )}

      {result?.ok && snapshot && (
        <article className="snapshot-card">
          <h3>快照内容</h3>
          <dl className="snapshot-grid">
            <dt>水印</dt>
            <dd className="watermark">{snapshot.watermarkContent}</dd>
            <dt>链接编号</dt>
            <dd>{snapshot.linkCode}</dd>
            <dt>目标数据集</dt>
            <dd>{snapshot.targetDataset || '—'}</dd>
            <dt>数据集名称</dt>
            <dd>{snapshot.datasetName || '—'}</dd>
            <dt>数据来源表</dt>
            <dd>{snapshot.datasetSourceTable || '—'}</dd>
            <dt>报告模板</dt>
            <dd>{snapshot.templateName || '—'}</dd>
            <dt>包含图表</dt>
            <dd>{snapshot.templateChartList || '—'}</dd>
            <dt>快照生成时间</dt>
            <dd>{formatTime(snapshot.capturedAt)}</dd>
            <dt>快照校验和</dt>
            <dd>{snapshot.checksum}</dd>
          </dl>
          <p className="hint-text">
            首次访问 {formatTime(result.firstViewedAt)}，本次为第 {result.viewCount}/{result.maxViews} 次访问
            {result.isFirstVisit ? '（首次访问已记录）' : ''}。后续模板改名、数据集调整都不会改变这里的内容。
          </p>
          {result.file && (
            <button className="btn" type="button" onClick={() => void runAccess('download')} disabled={busy || !downOpen}>
              再次下载
            </button>
          )}
        </article>
      )}

      <footer className="page-foot">
        <span>访问结果会记录来源渠道与成败，失败访问不计入浏览次数。</span>
      </footer>
    </section>
  )
}
