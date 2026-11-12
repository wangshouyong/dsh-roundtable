/** 左栏列表：会话行 / 群列表 / 通讯录 / 联系人行。 */
import { useEffect, useState } from 'react'
import type { ImService } from '../../core/im.ts'
import { stripLegacyReasoning } from '../../core/text.ts'
import type { Persona, Thread } from '../../core/types.ts'
import { findModel, type ModelCatalog } from '../../host/models.ts'
import { Avatar } from '../Avatar.tsx'
import { WorkspacePicker, useWorkspaces } from './workspaces.tsx'
import { formatListStamp } from '../../core/time.ts'
import { IconMore } from './icons.tsx'

export function SessionRow(props: {
  thread: Thread
  index: number
  active: boolean
  im: ImService
  onOpen: (t: Thread) => void
  onClearHistory: (t: Thread) => void
  onDeleteThread: (t: Thread) => void
}) {
  const { thread: t, index, active, im, onOpen, onClearHistory, onDeleteThread } = props
  const [menu, setMenu] = useState(false)
  // 点页面其它地方关闭菜单（菜单项自己 stopPropagation）。
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])
  const peer = t.kind === 'dm' ? im.state.personas.find((p) => p.id === t.memberIds[0]) : undefined
  const kind = t.kind === 'group' ? '群' : t.kind === 'triad' ? '三人小窗' : ''
  return (
    <div className={`row ${active ? 'on' : ''}`} onClick={() => onOpen(t)} title={t.title}>
      {peer ? <Avatar persona={peer} index={index} /> : <div className={`avatar a${index % 5}`}>{t.title.slice(0, 1)}</div>}
      <div className="meta">
        <div className="name">
          <span className="title">{t.title}</span>
          {kind ? <em className="kind">{kind}</em> : null}
          <span className="time">{formatListStamp(t.updatedAt)}</span>
          <button
            type="button"
            className="row-more"
            aria-label={`${t.title} 的操作`}
            aria-haspopup="menu"
            aria-expanded={menu}
            title="清空聊天记录 / 删除会话"
            onClick={(event) => {
              event.stopPropagation()
              setMenu((value) => !value)
            }}
          >
            <IconMore size={14} />
          </button>
        </div>
        <div className="preview-row">
          <span className="preview">
            {t.kind !== 'dm' ? `${t.memberIds.length + 1} 人 · ` : ''}
            {t.messages.at(-1)?.text ? stripLegacyReasoning(t.messages.at(-1)!.text) : '暂无消息'}
          </span>
          {t.unread > 0 ? <span className="unread">{t.unread > 99 ? '99+' : t.unread}</span> : null}
        </div>
      </div>
      {menu ? (
        <div className="menu row-menu" role="menu" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setMenu(false); onClearHistory(t) }}
          >
            清空聊天记录
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => { setMenu(false); onDeleteThread(t) }}
          >
            {t.kind === 'group' ? '解散群' : '删除会话'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function GroupList(props: {
  im: ImService
  q: string
  setQ: (s: string) => void
  activeId?: string
  onOpen: (t: Thread) => void
  onCreate: () => void
  onClearHistory: (t: Thread) => void
  onDeleteThread: (t: Thread) => void
}) {
  const { im, q, setQ, activeId, onOpen, onCreate, onClearHistory, onDeleteThread } = props
  const groups = im.state.threads.filter((t) => t.kind === 'group' && (!q || t.title.includes(q)))
  const triads = im.state.threads.filter((t) => t.kind === 'triad' && (!q || t.title.includes(q)))
  return (
    <div className="rows">
      <input className="search" placeholder="搜索群名称" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="group-label">我的群（{groups.length}）</div>
      {groups.length === 0 && <div className="empty sm">还没有群。到通讯录勾选角色后点「创建群聊」。</div>}
      {groups.map((t, i) => (
        <SessionRow key={t.id} thread={t} index={i} active={t.id === activeId} im={im} onOpen={onOpen} onClearHistory={onClearHistory} onDeleteThread={onDeleteThread} />
      ))}
      {triads.length > 0 && <div className="group-label">三人小窗（{triads.length}）</div>}
      {triads.map((t, i) => (
        <SessionRow key={t.id} thread={t} index={i} active={t.id === activeId} im={im} onOpen={onOpen} onClearHistory={onClearHistory} onDeleteThread={onDeleteThread} />
      ))}
      <button type="button" className="text-link" onClick={onCreate}>＋ 去通讯录拉群</button>
    </div>
  )
}

export function Contacts(props: {
  im: ImService
  q: string
  setQ: (s: string) => void
  projectRoot: string
  selectedPersonaId?: string
  onPersona: (p: Persona) => void
  onThread: (t: Thread) => void
  onCreate: () => void
  models: ModelCatalog
}) {
  const { im, q, setQ, projectRoot, selectedPersonaId, onPersona, onThread, onCreate, models } = props
  const workspaces = useWorkspaces()
  const [pick, setPick] = useState<string[]>([])
  const [pickMode, setPickMode] = useState(false)
  const [root, setRoot] = useState(projectRoot)
  // 群名：建群时才填（勾 2 个人是三人小窗，标题按角色名派生，不需要输入）。
  const [groupName, setGroupName] = useState('')

  const people = im.state.personas.filter((p) => !q || p.name.includes(q) || p.duties.some((d) => d.includes(q)) || p.personality.includes(q))

  function togglePick(id: string) {
    setPick((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  return (
    <div className="rows">
      <input className="search" placeholder="搜索角色 / 姓名 / 职责" value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="button" className="add-btn" onClick={onCreate}>+ 新建角色</button>
      {people.map((p) => (
        <ContactRow
          key={p.id}
          persona={p}
          index={im.state.personas.indexOf(p)}
          selected={selectedPersonaId === p.id}
          modelLabel={findModel(models, p.model)?.label ?? p.model}
          pickMode={pickMode}
          picked={pick.includes(p.id)}
          onPick={() => togglePick(p.id)}
          onOpen={() => onPersona(p)}
        />
      ))}

      {pickMode ? (
        <div className="form">
          {pick.length !== 2 && (
            <label className="field">
              <span>群名</span>
              <input
                value={groupName}
                maxLength={40}
                placeholder="例如：方案评审组（不填就叫「新群」）"
                onChange={(e) => setGroupName(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>关联工作区</span>
            {workspaces.length
              ? <WorkspacePicker value={root} options={workspaces} onChange={setRoot} />
              : <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="例如 D:\work\team" />}
          </label>
          <div className="field-hint">默认当前工作区；下拉来自 DSH 原生工作区列表（新的在 DSH 里「添加工作区」后刷新面板）。</div>
          <button
            type="button"
            disabled={pick.length < 2 || !root.trim()}
            onClick={() => {
              const project = root.trim()
              if (pick.length === 2) onThread(im.createTriad([pick[0], pick[1]], project))
              else onThread(im.createGroup(groupName, pick, project))
              setPick([])
              setGroupName('')
              setPickMode(false)
              setRoot(projectRoot)
            }}
          >
            {pick.length === 2 ? '创建三人小窗' : '创建群聊'}
          </button>
          <button type="button" className="ghost" onClick={() => { setPickMode(false); setPick([]); setGroupName('') }}>取消</button>
        </div>
      ) : (
        <button type="button" className="text-link" onClick={() => { setRoot(projectRoot); setGroupName(''); setPickMode(true) }}>＋ 创建群聊</button>
      )}
    </div>
  )
}

export function ContactRow(props: {
  persona: Persona
  index: number
  selected: boolean
  modelLabel: string
  pickMode: boolean
  picked: boolean
  onPick: () => void
  onOpen: () => void
}) {
  const { persona: p, index, selected, modelLabel, pickMode, picked, onPick, onOpen } = props
  return (
    <div className={`row ${selected ? 'on' : ''}`} onClick={pickMode ? onPick : onOpen}>
      {pickMode && <input type="checkbox" checked={picked} readOnly />}
      <Avatar persona={p} index={index} />
      <div className="meta">
        <div className="name">
          <span className="title">{p.name}</span>
          {p.post ? <em className="kind">{p.post}</em> : null}
          <span className="time" title={modelLabel}>{modelLabel}</span>
        </div>
        <div className="preview-row">
          <span className="preview">{p.duties.join(' · ')}</span>
        </div>
      </div>
    </div>
  )
}

