/** 回收站弹窗：列出被删除的会话/角色/聊天记录，可恢复或彻底删除。 */
import type { TrashEntryMeta } from '../../core/trash.ts'
import { TRASH_KIND_LABEL } from '../../core/trash.ts'
import { formatStamp } from '../../core/time.ts'
import { IconRestore, IconTrash } from './icons.tsx'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function TrashDialog(props: {
  entries: TrashEntryMeta[]
  loading: boolean
  busy: boolean
  error?: string
  onClose: () => void
  onRestore: (entry: TrashEntryMeta) => void
  onPurge: (entry: TrashEntryMeta) => void
  onPurgeAll: () => void
}) {
  const { entries, loading, busy, error, onClose, onRestore, onPurge, onPurgeAll } = props
  const totalBytes = entries.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0)

  return (
    <div
      className="ws-dialog-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="ws-dialog trash-dialog" role="dialog" aria-modal="true" aria-label="回收站">
        <div className="ws-dialog-head">
          <h2>回收站</h2>
          <button type="button" className="ws-dialog-close" onClick={onClose} disabled={busy}>关闭</button>
        </div>
        {error ? <div className="alert danger">{error}</div> : null}
        <div className="trash-summary">
          <span>{loading ? '读取中…' : `${entries.length} 项 · 占用 ${formatBytes(totalBytes)}`}</span>
          <span className="spacer" />
          {entries.length > 0 ? (
            <button type="button" className="text-link danger" onClick={onPurgeAll} disabled={busy}>
              清空回收站
            </button>
          ) : null}
        </div>
        <div className="trash-list">
          {entries.length === 0 && !loading ? (
            <div className="empty sm">回收站是空的。删除的会话、解散的群、删掉的角色和被清空的聊天记录会先放在这里。</div>
          ) : null}
          {entries.map((entry) => (
            <div key={entry.id} className="trash-row">
              <span className={`trash-kind ${entry.kind}`}>{TRASH_KIND_LABEL[entry.kind]}</span>
              <div className="trash-main">
                <div className="trash-label" title={entry.label}>{entry.label}</div>
                <div className="trash-meta">
                  {entry.detail ? `${entry.detail} · ` : ''}
                  {formatStamp(entry.deletedAt)} · {formatBytes(entry.bytes)}
                </div>
              </div>
              <div className="trash-actions">
                <button type="button" onClick={() => onRestore(entry)} disabled={busy}>
                  <IconRestore size={12} /> 恢复
                </button>
                <button type="button" className="danger" onClick={() => onPurge(entry)} disabled={busy}>
                  <IconTrash size={12} /> 彻底删除
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="trash-foot">
          回收站里的内容不会再被角色读取；恢复后回到原来的会话/通讯录。
        </div>
      </div>
    </div>
  )
}
