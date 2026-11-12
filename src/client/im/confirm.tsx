/** 通用二次确认弹窗：删除/解散/清空/彻底删除都从这里走，样式与群信息弹窗同一套。 */
import { useEffect } from 'react'

export interface ConfirmSpec {
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  /** 危险动作（删除/解散/彻底删除）：确认按钮用红色。 */
  danger?: boolean
  /** 额外要点（会逐条列出，例如"会一起删除哪些东西"）。 */
  bullets?: string[]
}

export function ConfirmDialog(props: {
  spec: ConfirmSpec
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { spec, busy, onCancel, onConfirm } = props
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div
      className="ws-dialog-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div className="ws-dialog confirm-dialog" role="dialog" aria-modal="true" aria-label={spec.title}>
        <div className="ws-dialog-head">
          <h2>{spec.title}</h2>
          <button type="button" className="ws-dialog-close" onClick={onCancel} disabled={busy}>关闭</button>
        </div>
        <div className="confirm-body">
          <p>{spec.description}</p>
          {spec.bullets?.length ? (
            <ul>
              {spec.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
            </ul>
          ) : null}
        </div>
        <div className="confirm-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{spec.cancelLabel ?? '取消'}</button>
          <button
            type="button"
            className={spec.danger ? 'danger' : ''}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '执行中…' : spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
