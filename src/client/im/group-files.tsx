/** 群工作区「文件」面板：列群目录里的文件/产物（角色写的文件、本轮汇总、附件），可进目录、预览文本/图片。 */
import { useEffect, useMemo, useState } from 'react'
import type { Thread } from '../../core/types.ts'
import { formatStamp } from '../../core/time.ts'
import { groupFileUrl, loadGroupFiles, loadGroupFileText, type GroupFileEntry, type GroupFileListing } from '../httpStore.ts'
import { formatBytes } from './trash-dialog.tsx'
import { IconChevronRight, IconFile, IconFolder, IconImage, IconRestore } from './icons.tsx'

const MAX_PREVIEW_CHARS = 200_000

type PreviewState =
  | { kind: 'loading'; entry: GroupFileEntry }
  | { kind: 'text'; entry: GroupFileEntry; text: string; truncated: boolean }
  | { kind: 'image'; entry: GroupFileEntry }
  | { kind: 'binary'; entry: GroupFileEntry }
  | { kind: 'error'; entry: GroupFileEntry; message: string }

function isImage(entry: GroupFileEntry): boolean {
  return Boolean(entry.mediaType?.startsWith('image/'))
}

function isText(entry: GroupFileEntry): boolean {
  const type = entry.mediaType ?? ''
  if (type.startsWith('text/')) return true
  return type === 'application/json' || type === 'application/xml'
}

export function GroupFilesPane(props: { thread: Thread; projectRoot: string }) {
  const { thread, projectRoot } = props
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<GroupFileListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // 换群/换目录自动重新列；切群时回到群目录根。
  useEffect(() => {
    setPath('')
  }, [thread.id])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void loadGroupFiles(thread.id, path, projectRoot)
      .then((next) => { if (!cancelled) setListing(next) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [thread.id, path, projectRoot, reloadKey])

  const segments = useMemo(() => (path ? path.split('/').filter(Boolean) : []), [path])
  const groupDirLabel = `${thread.projectRoot.replace(/[\\/]+$/, '')}/.dsh-im/groups/${thread.id}`

  async function openPreview(entry: GroupFileEntry): Promise<void> {
    if (entry.kind === 'dir') {
      setPath(entry.path)
      return
    }
    if (isImage(entry)) {
      setPreview({ kind: 'image', entry })
      return
    }
    if (!isText(entry)) {
      setPreview({ kind: 'binary', entry })
      return
    }
    setPreview({ kind: 'loading', entry })
    try {
      const text = await loadGroupFileText(thread.id, entry.path, projectRoot)
      const truncated = text.length > MAX_PREVIEW_CHARS
      setPreview({
        kind: 'text',
        entry,
        text: truncated ? text.slice(0, MAX_PREVIEW_CHARS) : text,
        truncated,
      })
    } catch (err) {
      setPreview({ kind: 'error', entry, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="group-files">
      <div className="files-head">
        <h3>群文件</h3>
        <button
          type="button"
          className="icon-btn"
          aria-label="刷新文件列表"
          title="刷新"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          <IconRestore size={14} />
        </button>
      </div>
      <div className="files-crumbs" aria-label="文件路径">
        <button type="button" className={`crumb ${segments.length === 0 ? 'on' : ''}`} onClick={() => setPath('')}>
          群目录
        </button>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`} className="crumb-wrap">
            <IconChevronRight size={10} />
            <button
              type="button"
              className={`crumb ${index === segments.length - 1 ? 'on' : ''}`}
              onClick={() => setPath(segments.slice(0, index + 1).join('/'))}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>
      <div className="files-list">
        {loading ? <div className="files-hint">读取中…</div> : null}
        {error ? <div className="files-error">{error}</div> : null}
        {!loading && !error && listing && !listing.exists ? (
          <div className="empty sm">这个会话还没有群目录。角色写文件、点「先汇总」或上传附件后会出现在这里。</div>
        ) : null}
        {!loading && !error && listing?.exists && listing.entries.length === 0 ? (
          <div className="empty sm">目录是空的。角色写文件或点「先汇总」后会出现在这里。</div>
        ) : null}
        {!loading && listing?.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={`file-row ${entry.kind}`}
            title={entry.kind === 'file' && entry.modifiedAt ? formatStamp(entry.modifiedAt) : entry.path}
            onClick={() => { void openPreview(entry) }}
          >
            <span className="file-icon">
              {entry.kind === 'dir' ? <IconFolder size={14} /> : isImage(entry) ? <IconImage size={14} /> : <IconFile size={14} />}
            </span>
            <span className="file-name">{entry.name}</span>
            <span className="file-meta">
              {entry.kind === 'dir' ? '' : formatBytes(entry.bytes ?? 0)}
            </span>
            {entry.kind === 'dir' ? <span className="file-chevron"><IconChevronRight size={11} /></span> : null}
          </button>
        ))}
        {listing?.truncated ? <div className="files-hint">条目太多，只显示前 500 项。</div> : null}
      </div>
      <div className="files-foot" title={groupDirLabel}>
        角色写的文件、本轮汇总与附件都在群目录里；这里只读。
      </div>

      {preview ? (
        <div
          className="ws-dialog-mask"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null) }}
        >
          <div className="ws-dialog file-preview-dialog" role="dialog" aria-label={preview.entry.name}>
            <div className="ws-dialog-head">
              <h2 className="file-preview-title" title={preview.entry.path}>{preview.entry.name}</h2>
              <div className="file-preview-head-actions">
                {preview.kind !== 'loading' && preview.kind !== 'error' ? (
                  <a
                    className="text-link"
                    href={groupFileUrl(thread.id, preview.entry.path, projectRoot)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开原文件
                  </a>
                ) : null}
                <button type="button" className="ws-dialog-close" onClick={() => setPreview(null)}>关闭</button>
              </div>
            </div>
            <div className="file-preview-body">
              <div className="files-hint">
                {preview.entry.path} · {formatBytes(preview.entry.bytes ?? 0)}
                {preview.entry.modifiedAt ? ` · ${formatStamp(preview.entry.modifiedAt)}` : ''}
              </div>
              {preview.kind === 'loading' ? <div className="files-hint">读取中…</div> : null}
              {preview.kind === 'error' ? <div className="files-error">{preview.message}</div> : null}
              {preview.kind === 'text' ? (
                <>
                  <pre className="file-text">{preview.text || '（空文件）'}</pre>
                  {preview.truncated ? <div className="files-hint">内容过长，只预览前 200,000 字符；完整内容请点「打开原文件」。</div> : null}
                </>
              ) : null}
              {preview.kind === 'image' ? (
                <img
                  className="file-image"
                  src={groupFileUrl(thread.id, preview.entry.path, projectRoot)}
                  alt={preview.entry.name}
                />
              ) : null}
              {preview.kind === 'binary' ? (
                <div className="files-hint">
                  这是二进制文件，不能在面板里预览。
                  <a className="text-link" href={groupFileUrl(thread.id, preview.entry.path, projectRoot)} target="_blank" rel="noreferrer">
                    在新标签打开 / 下载
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
