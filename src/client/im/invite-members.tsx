/** 邀请成员进群：列出通讯录里还没入群的角色，多选后加入当前群。 */
import { useMemo, useState } from 'react'
import type { ImService } from '../../core/im.ts'
import type { Thread } from '../../core/types.ts'
import { Avatar } from '../Avatar.tsx'

export function InviteMembersDialog(props: {
  im: ImService
  thread: Thread
  onClose: () => void
  /** 调 ImService.addMembers 并刷新；返回实际新增/跳过的角色名（用于如实反馈）。 */
  onInvite: (personaIds: string[]) => Promise<{ added: string[]; skipped: string[] }>
}) {
  const { im, thread, onClose, onInvite } = props
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 已在群里的角色不出现（候选是"还没进群的人"）。
  const candidates = useMemo(
    () => im.state.personas.filter((persona) => !thread.memberIds.includes(persona.id)),
    [im.state.personas, thread.memberIds.join(',')],
  )
  const visible = candidates.filter((persona) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return persona.name.toLowerCase().includes(q)
      || (persona.post ?? '').toLowerCase().includes(q)
      || persona.duties.some((duty) => duty.toLowerCase().includes(q))
  })

  function toggle(personaId: string) {
    setPicked((current) => (
      current.includes(personaId) ? current.filter((id) => id !== personaId) : [...current, personaId]
    ))
  }

  async function confirm() {
    if (busy || picked.length === 0) return
    setBusy(true)
    setError('')
    try {
      const result = await onInvite(picked)
      if (result.added.length === 0) {
        // 候选列表里的角色在打开弹窗后被别处加进来了：如实说明，不假装成功。
        setError('这些角色已经在群里了，换个人再试')
        setPicked([])
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="ws-dialog-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="ws-dialog invite-dialog" role="dialog" aria-modal="true" aria-label="邀请成员">
        <div className="ws-dialog-head">
          <h2>邀请成员进群</h2>
          <button type="button" className="ws-dialog-close" onClick={onClose} disabled={busy}>关闭</button>
        </div>
        <div className="invite-body">
          <div className="field-hint">只列出还没在「{thread.title}」里的角色。要新角色请先去通讯录「新建角色」。</div>
          <input
            className="search invite-search"
            placeholder="搜索角色 / 岗位 / 职责"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {error ? <div className="files-error">{error}</div> : null}
          {candidates.length === 0 ? (
            <div className="empty sm">所有角色都已经在群里了。要新角色请先去通讯录「新建角色」。</div>
          ) : visible.length === 0 ? (
            <div className="empty sm">没有匹配「{query}」的角色。</div>
          ) : (
            <div className="invite-list">
              {visible.map((persona) => (
                <label key={persona.id} className={`row invite-row ${picked.includes(persona.id) ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={picked.includes(persona.id)}
                    onChange={() => toggle(persona.id)}
                  />
                  <Avatar persona={persona} index={im.state.personas.indexOf(persona)} />
                  <div className="meta">
                    <div className="name">
                      <span className="title">{persona.name}</span>
                      {persona.post ? <em className="kind">{persona.post}</em> : null}
                    </div>
                    <div className="preview-row">
                      <span className="preview">{persona.duties.join(' · ') || '协作者'}</span>
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="confirm-actions">
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className="primary"
            onClick={() => { void confirm() }}
            disabled={busy || picked.length === 0}
          >
            {busy ? '邀请中…' : picked.length ? `邀请（${picked.length}）` : '邀请'}
          </button>
        </div>
      </div>
    </div>
  )
}
