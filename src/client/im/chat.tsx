/** 聊天主区：消息流 / 输入框 / 附件 / @ 提及 / 执行轨迹 / 本轮安排。 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { activeMention } from '../../core/ids.ts'
import { stripLegacyReasoning } from '../../core/text.ts'
import { formatDayLabel, formatStamp, isSameDay } from '../../core/time.ts'
import type { ImService } from '../../core/im.ts'
import type { ModelCatalog } from '../../host/models.ts'
import type { MessageAttachment, Persona, Thread, TurnTrace } from '../../core/types.ts'
import { Avatar } from '../Avatar.tsx'
import { attachmentUrl, onNativeCompat, uploadAttachment } from '../httpStore.ts'
import { blockedAdvice } from '../../core/blocked.ts'
import { MentionText, fmt, useNarrow } from './shared.tsx'
import { IconAlert, IconChat, IconChevronDown, IconFile, IconImage, IconMore, IconPaperclip, IconSend, IconUsers } from './icons.tsx'
import { PersonaProfile } from './persona-profile.tsx'
import { GroupFilesPane } from './group-files.tsx'
import { ActivityPane, FactsBoard, GroupRightPane, MemberPane, RoundPlan, traceToolLabel, type GroupRightTab } from './right-pane.tsx'
import { useWorkspaces, WorkspacePicker } from './workspaces.tsx'

export function mentionChoicesFor(im: ImService, thread: Thread, query: string, groupLike: boolean): { key: string; name: string; hint: string }[] {
  const q = query.trim().toLowerCase()
  const match = (name: string) => !q || name.toLowerCase().includes(q)
  const people = thread.memberIds
    .map((id) => im.state.personas.find((p) => p.id === id))
    .filter((p): p is Persona => Boolean(p))
    .filter((p) => match(p.name))
    .map((p) => ({ key: p.id, name: p.name, hint: p.duties[0] || '成员' }))
  const all = groupLike && match('全体') ? [{ key: 'all', name: '全体', hint: '本群所有角色' }] : []
  return [...all, ...people]
}

export function Chat(props: {
  im: ImService
  thread: Thread
  draft: string
  setDraft: (s: string) => void
  run: (fn: () => Promise<unknown> | unknown) => Promise<void>
  profilePersona?: Persona
  onShowProfile: (id: string) => void
  onHideProfile: () => void
  onEditPersona: (p: Persona) => void
  onDeletePersona: (p: Persona) => void
  onClearThreadHistory: (t: Thread) => void
  onDeleteThread: (t: Thread) => void
  projectRoot: string
  refresh: () => void
  models: ModelCatalog
}) {
  const { im, thread, draft, setDraft, run, profilePersona, onShowProfile, onHideProfile, onEditPersona, onDeletePersona, onClearThreadHistory, onDeleteThread, projectRoot, refresh, models } = props
  const workspaces = useWorkspaces()
  const groupLike = thread.kind !== 'dm'
  // 群名是用户起的；三人小窗默认标题按角色名派生，点标题改名后锁定；DM 标题不可改（core 拒绝）。
  const canRename = thread.kind !== 'dm'
  const nameLabel = thread.kind === 'group' ? '群名' : '小窗名'
  const count = thread.memberIds.length + 1
  const done = thread.members.filter((m) => m.completedRound || m.passedRound).length
  const lastDecision = thread.floorDecisions?.at(-1)
  const lastWait = lastDecision?.action === 'wait' ? lastDecision : undefined
  const chatMsgs = thread.messages.filter((m) => m.kind !== 'system' || !m.text.includes('本轮开始'))
  const empty = chatMsgs.filter((m) => m.kind !== 'system').length === 0
  const peer = groupLike ? undefined : im.state.personas.find((p) => p.id === thread.memberIds[0])
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [attachError, setAttachError] = useState('')
  const narrow = useNarrow()
  const [rightTab, setRightTab] = useState<GroupRightTab>('members')
  const [overlayTab, setOverlayTab] = useState<GroupRightTab | null>(null)
  const [activityFilter, setActivityFilter] = useState<string | undefined>(undefined)
  const [traceDetail, setTraceDetail] = useState<TurnTrace | null>(null)
  const [compatNotice, setCompatNotice] = useState<string | null>(null)
  // 顶部「本轮暂停」状态条的详情展开（默认收起，只在需要看失败码/建议时展开）。
  const [blockedOpen, setBlockedOpen] = useState(false)
  // 群名行内编辑：null = 不在编辑态；切群时丢弃草稿。
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  // 顶部「…」会话菜单：清空聊天记录 / 删除会话（群叫解散群）。
  const [headMenu, setHeadMenu] = useState(false)
  // 会话文件弹窗（DM 没有右栏，用弹窗看群工作区；群/小窗在右栏「文件」Tab）。
  const [filesOpen, setFilesOpen] = useState(false)
  useEffect(() => {
    setTitleDraft(null)
    setHeadMenu(false)
    setFilesOpen(false)
  }, [thread.id])
  useEffect(() => {
    if (!headMenu) return
    const close = () => setHeadMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [headMenu])
  // 换群 / 换一次中断（新的 blocked.at）时收起详情，避免把上一次的报错细节留在屏上。
  useEffect(() => {
    setBlockedOpen(false)
  }, [thread.id, thread.blocked?.at])
  useEffect(() => {
    setCompatNotice(null)
    return onNativeCompat((notice) => {
      if (notice.threadId && notice.threadId !== thread.id) return
      setCompatNotice(notice.text || null)
    })
  }, [thread.id])
  const groupFacts = groupLike ? im.factsFor(thread.id) : []
  const activityCount = thread.traces?.length ?? 0
  const pendingQueue = thread.members.filter((member) => !member.completedRound && !member.passedRound).length
  // 新消息/切换会话时自动滚到最底部。
  const lastMessageId = chatMsgs.at(-1)?.id
  useEffect(() => {
    const feed = feedRef.current
    if (!feed) return
    const frame = requestAnimationFrame(() => {
      feed.scrollTop = feed.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [thread.id, lastMessageId, chatMsgs.length])
  const [mentionHi, setMentionHi] = useState(0)
  const [preflight, setPreflight] = useState<{
    error?: string
    members?: { personaId: string; name: string; ok: boolean; reason?: string }[]
  } | null>(null)
  const mention = activeMention(draft, caret)
  const mentionChoices = mention
    ? mentionChoicesFor(im, thread, mention.query, groupLike)
    : []
  const mentionIndex = mentionChoices.length === 0 ? 0 : Math.min(mentionHi, mentionChoices.length - 1)

  function rememberCaret(el: HTMLTextAreaElement) {
    setCaret(el.selectionStart)
  }

  function insertMention(name: string) {
    if (!mention) return
    const next = `${draft.slice(0, mention.start)}@${name} ${draft.slice(caret)}`
    const pos = mention.start + name.length + 2
    setDraft(next)
    setCaret(pos)
    setMentionHi(0)
    requestAnimationFrame(() => {
      boxRef.current?.focus()
      boxRef.current?.setSelectionRange(pos, pos)
    })
  }

  async function startReview() {
    try {
      const res = await fetch('/api/im/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: thread.id, projectRoot }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        members?: { personaId: string; name: string; ok: boolean; reason?: string }[]
        error?: string
      }
      if (!res.ok) {
        setPreflight({ error: data.error ?? '体检失败 ' + res.status })
        return
      }
      if (data.ok) {
        setPreflight(null)
        await run(() => im.sendUser(thread.id, '开始评审', { startReview: true }))
        return
      }
      setPreflight({ members: data.members ?? [] })
    } catch (err) {
      setPreflight({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function addFiles(files: FileList | File[] | null | undefined) {
    if (!files) return
    const list = Array.from(files).slice(0, 4)
    if (list.length === 0) return
    setUploading(true)
    setAttachError('')
    try {
      for (const file of list) {
        const { attachment } = await uploadAttachment({
          threadId: thread.id,
          projectRoot: thread.projectRoot,
          file,
        })
        setPendingAttachments((prev) => [...prev, attachment])
      }
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  const rightContent = (tab: GroupRightTab, onActivity = (personaId: string) => { setActivityFilter(personaId); setRightTab('activity') }) => (
    tab === 'members'
      ? <MemberPane im={im} thread={thread} refresh={refresh} onShowProfile={onShowProfile} onShowActivity={onActivity} />
      : tab === 'facts'
        ? <FactsBoard im={im} thread={thread} run={run} />
        : tab === 'queue'
          ? <RoundPlan im={im} thread={thread} />
          : tab === 'files'
            ? <GroupFilesPane thread={thread} projectRoot={thread.projectRoot} />
            : <ActivityPane im={im} thread={thread} filter={activityFilter} onFilter={setActivityFilter} onOpenTrace={setTraceDetail} />
  )

  /** 提交群名：空/没改就丢弃；改了就落库（run 会刷新并触发保存）。 */
  function commitTitle() {
    const next = (titleDraft ?? '').trim()
    setTitleDraft(null)
    if (!next || next === thread.title) return
    void run(() => im.setThreadTitle(thread.id, next))
  }

  function sendDraft() {
    const text = draft.trim()
    if (!text && pendingAttachments.length === 0) return
    const attachments = pendingAttachments
    setDraft('')
    setCaret(0)
    setPendingAttachments([])
    setAttachError('')
    void run(() => im.sendUser(thread.id, text, attachments.length ? { attachments } : undefined))
  }

  return (
    <>
      <section className="col-chat">
        <header className="head">
          <div className="head-left">
            {peer ? (
              <button
                type="button"
                className="head-avatar-btn"
                aria-label={`查看${peer.name}的角色资料`}
                title="查看角色资料"
                onClick={() => onShowProfile(peer.id)}
              >
                <Avatar persona={peer} />
              </button>
            ) : (
              <div className="group-avatar" aria-hidden="true"><IconUsers size={18} /></div>
            )}
            <div>
              {canRename && titleDraft !== null ? (
                <input
                  className="group-title-input"
                  aria-label={nameLabel}
                  autoFocus
                  maxLength={40}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitTitle()
                    } else if (e.key === 'Escape') {
                      setTitleDraft(null)
                    }
                  }}
                />
              ) : (
                <h1
                  className={canRename ? 'editable' : undefined}
                  title={canRename ? `点击改${nameLabel}` : undefined}
                  onClick={canRename ? () => setTitleDraft(thread.title) : undefined}
                >
                  {thread.title}
                  {groupLike ? <span className="head-count">{count} 人</span> : null}
                </h1>
              )}
              <div className="sub">
                <span>记忆仅限{thread.kind === 'dm' ? '本私聊' : '本群'}</span>
                {groupLike ? (
                  <span className="inline-edit">
                    <span className="dot-sep">·</span>
                    <span>工作区</span>
                    <WorkspacePicker
                      compact
                      value={thread.projectRoot}
                      options={workspaces}
                      onChange={(path) => { void run(() => im.setThreadProjectRoot(thread.id, path)) }}
                    />
                  </span>
                ) : ''}
              </div>
            </div>
          </div>
          <div className="head-actions">
            {groupLike ? (
              <>
                <button className="primary" onClick={() => void startReview()}>开始评审</button>
                <button onClick={() => run(() => im.requestSummary(thread.id))}>先汇总</button>
                <button onClick={() => run(() => im.pauseRound(thread.id))}>全员暂停</button>
              </>
            ) : null}
            <div className="head-more-wrap">
              <button
                type="button"
                className="head-more-btn"
                aria-label="会话操作"
                aria-haspopup="menu"
                aria-expanded={headMenu}
                title="清空聊天记录 / 删除会话"
                onClick={(event) => {
                  event.stopPropagation()
                  setHeadMenu((value) => !value)
                }}
              >
                <IconMore size={14} />
              </button>
              {headMenu ? (
                <div className="menu head-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setHeadMenu(false); setFilesOpen(true) }}
                  >
                    {groupLike ? '群文件' : '会话文件'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setHeadMenu(false); onClearThreadHistory(thread) }}
                  >
                    清空聊天记录
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => { setHeadMenu(false); onDeleteThread(thread) }}
                  >
                    {groupLike ? '解散群' : '删除会话'}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        {groupLike && narrow ? (
          <div className="narrow-bar">
            <button type="button" onClick={() => setOverlayTab('members')}>成员 {thread.memberIds.length + 1}</button>
            <button type="button" onClick={() => setOverlayTab('facts')}>任务板 {groupFacts.length}</button>
            <button type="button" onClick={() => setOverlayTab('queue')}>候选 {pendingQueue}</button>
            <button type="button" onClick={() => setOverlayTab('activity')}>执行 {activityCount}</button>
            <button type="button" onClick={() => setOverlayTab('files')}>文件</button>
          </div>
        ) : null}
        {/* 本轮中断 = 当前轮状态，不是历史消息：固定在 header 下方，任何滚动位置都能看到并处理。
            历史留痕由 resolveBlocked() 写入的系统消息负责，移出聊天流不会丢证据。 */}
        {thread.blocked ? (
          <div className="status-strip" role="status">
            <span className="status-strip-icon"><IconAlert size={14} /></span>
            <div className="status-strip-text">
              <b>{thread.blocked.name} 调用失败</b>
              {thread.blocked.code ? <span className="status-pill danger">{thread.blocked.code}</span> : null}
              <span className="status-strip-msg">{thread.blocked.message}</span>
            </div>
            <div className="status-strip-actions">
              <button type="button" className="primary" onClick={() => void run(() => im.resolveBlocked(thread.id, 'retry'))}>已修好，重试</button>
              <button type="button" onClick={() => void run(() => im.resolveBlocked(thread.id, 'skip'))}>移除它，继续</button>
              <button type="button" onClick={() => void run(() => im.pauseRound(thread.id))}>暂停本轮</button>
              <button
                type="button"
                className="status-strip-toggle"
                aria-expanded={blockedOpen}
                onClick={() => setBlockedOpen((value) => !value)}
              >
                详情<IconChevronDown size={11} />
              </button>
            </div>
            {blockedOpen ? (
              <div className="status-strip-detail">
                <div><span>失败码</span><code>{thread.blocked.code ?? '—'}</code></div>
                <div><span>发生时间</span><code>{formatStamp(thread.blocked.at)}</code></div>
                <div><span>建议</span><span>{blockedAdvice(thread.blocked).hint}</span></div>
              </div>
            ) : null}
          </div>
        ) : null}
        {compatNotice && (
          <div className="banner">{compatNotice}</div>
        )}
        {im.state.pendingRecall?.threadId === thread.id && (
          <div className="banner">
            角色想调另一场摘要，先问你。
            <button onClick={() => run(() => im.confirmRecall(true))}>同意</button>
            <button onClick={() => run(() => im.confirmRecall(false))}>拒绝</button>
          </div>
        )}
        {preflight && (
          <div className="banner">
            <div>
              <b>开始前体检没通过</b>
              {preflight.error ? (
                <div>{preflight.error}</div>
              ) : (
                <ul className="preflight-list">
                  {(preflight.members ?? []).filter((m) => !m.ok).map((m) => (
                    <li key={m.personaId}>
                      {m.name}：{m.reason ?? '不可用'}
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => {
                          setPreflight(null)
                          void run(() => im.sendUser(thread.id, '开始评审', {
                            startReview: true,
                            excludePersonaIds: [m.personaId],
                          }))
                        }}
                      >本轮移除</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button onClick={() => void startReview()}>重新检测</button>
            <button onClick={() => { setPreflight(null); void run(() => im.sendUser(thread.id, '开始评审', { startReview: true })) }}>仍然开始</button>
          </div>
        )}
        <div className="feed" ref={feedRef}>
          {empty && peer ? (
            <div className="hero">
              <div className="hero-icon"><IconChat size={24} /></div>
              <h2>与{peer.name}开始聊天</h2>
              <p>{peer.personality}</p>
              <div className="hero-duties">
                {peer.duties.map((d) => <span key={d} className="chip">{d}</span>)}
              </div>
            </div>
          ) : empty ? (
            <div className="hero">
              <div className="hero-icon">{thread.kind === 'group' ? <IconUsers size={24} /> : <IconChat size={24} />}</div>
              <h2>{thread.kind === 'group' ? '群聊已创建' : '三人小窗已创建'}</h2>
              <p>{thread.kind === 'group'
                ? '成员已就位。发第一条消息，或点右上角「开始评审」让专家依次发言。'
                : '发第一条消息开始聊，或点右上角「开始评审」。'}</p>
              <div className="hero-duties">
                {thread.memberIds.map((id) => {
                  const member = im.state.personas.find((persona) => persona.id === id)
                  return member ? <span key={id} className="chip">{member.name}</span> : null
                })}
              </div>
            </div>
          ) : (
            <>
              {chatMsgs.map((m, index) => {
                // 跨天处插一条日期分隔条：昨天的 23:55 和今天的 17:08 不会再像同一天的两个时刻。
                const previous = index > 0 ? chatMsgs[index - 1] : undefined
                const divider = !previous || !isSameDay(previous.createdAt, m.createdAt)
                  ? <div className="stamp">{formatDayLabel(m.createdAt)}</div>
                  : null
                if (m.kind === 'system' && m.text.includes('汇总已写入')) {
                  return (
                    <Fragment key={m.id}>
                      {divider}
                      <div className="card ok">
                        <div>已汇总专家观点。{<MentionText text={m.text} />}</div>
                        <span className="pass">PASS</span>
                      </div>
                    </Fragment>
                  )
                }
                if (m.kind === 'system') {
                  return (
                    <Fragment key={m.id}>
                      {divider}
                      <div className="note">{<MentionText text={m.text} />}</div>
                    </Fragment>
                  )
                }
                // 我的发言：标准数据是 kind 'user'；没有 authorId 的非系统消息也一定是我
                // （兼容被外部脚本 / 演示数据写成 'text' 之类非标准 kind 的 state.json）。
                const mine = m.kind === 'user' || !m.authorId
                const author = mine ? undefined : im.state.personas.find((p) => p.id === m.authorId)
                // 岗位和角色名重复时不重复显示（「产品经理 · 产品」→「产品经理」）。
                const post = author?.post && !author.name.includes(author.post) && !author.post.includes(author.name)
                  ? author.post
                  : undefined
                // 同一人连续发言（同一天、6 分钟内）合并成一组：头像和名字只出现一次，气泡间距收紧。
                const grouped = Boolean(
                  previous
                  && !divider
                  && previous.kind === m.kind
                  && previous.authorId === m.authorId
                  && previous.authorName === m.authorName
                  && m.createdAt - previous.createdAt < 6 * 60_000,
                )
                const flags: { text: string; warn: boolean }[] = []
                if (m.interrupted) flags.push({ text: '已被打断', warn: false })
                if (m.stale) flags.push({ text: '基于旧版本', warn: true })
                if (m.pass) flags.push({ text: '本轮弃权', warn: false })
                if (m.windowReply) flags.push({ text: '按窗口回复', warn: false })
                return (
                  <Fragment key={m.id}>
                    {divider}
                    <div id={`msg-${m.seq ?? m.id}`} className={`msg ${mine ? 'mine' : ''}${grouped ? ' grouped' : ''}`}>
                    {grouped ? <div className="msg-gutter" /> : mine ? (
                      <Avatar text="你" />
                    ) : author ? (
                      // 点消息头像 = 打开/切换右侧角色资料（DM 关掉资料后从这里或标题头像重开）。
                      <button
                        type="button"
                        className="msg-avatar-btn"
                        aria-label={`查看${m.authorName}的角色资料`}
                        title="查看角色资料"
                        onClick={() => onShowProfile(author.id)}
                      >
                        <Avatar persona={author} text={m.authorName} />
                      </button>
                    ) : (
                      <Avatar text={m.authorName} />
                    )}
                    <div className="msg-main">
                      {grouped ? null : (
                        <div className="who">
                          <span className="who-name">{mine ? '你' : m.authorName}</span>
                          {post ? <span className="who-post">{post}</span> : null}
                          <span className="who-time">{formatStamp(m.createdAt)}</span>
                        </div>
                      )}
                      <div className="body">{<MentionText text={stripLegacyReasoning(m.text)} />}</div>
                      {flags.length > 0 ? (
                        <div className="msg-flags">
                          {flags.map((flag) => <span key={flag.text} className={`tag${flag.warn ? ' warn' : ''}`}>{flag.text}</span>)}
                        </div>
                      ) : null}
                      {m.attachments?.length ? (
                        <div className="attachments">
                          {m.attachments.map((attachment) => {
                            const url = attachment.path ? attachmentUrl(thread.id, thread.projectRoot, attachment.path) : undefined
                            if (attachment.kind === 'image' && url) {
                              return (
                                <a key={attachment.id} className="attachment-image" href={url} target="_blank" rel="noreferrer">
                                  <img src={url} alt={attachment.name} />
                                  {attachment.modelVisible === false ? <span className="attachment-warn">模型看不到这张图</span> : null}
                                </a>
                              )
                            }
                            return (
                              <a key={attachment.id} className="attachment-file" href={url} target="_blank" rel="noreferrer">
                                <span className="attachment-icon"><IconFile size={14} /></span>
                                <span className="attachment-name">{attachment.name}</span>
                                <span className="attachment-size">{Math.max(1, Math.round(attachment.bytes / 1024))}KB</span>
                                {attachment.modelVisible === false ? <span className="attachment-warn">模型不可见</span> : null}
                              </a>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                    </div>
                  </Fragment>
                )
              })}
            </>
          )}
        </div>
        <div className="floor">
          <span className={`floor-dot${thread.speakingPersonaId ? ' live' : lastWait ? ' wait' : ''}`} />
          <span className="floor-text">
            {thread.speakingPersonaId ? (
              <>
                <b>{im.state.personas.find((p) => p.id === thread.speakingPersonaId)?.name ?? '该角色'}</b>
                {' 正在发言'}
                <span className="dot-sep"> · </span>
                {'下一位 '}
                {thread.nextHint ?? '—'}
              </>
            ) : groupLike && lastWait ? (
              <>
                {'等待 '}
                <b>{im.state.personas.find((p) => p.id === lastWait.personaId)?.name ?? '该角色'}</b>
                {' 处理完，再继续本轮'}
              </>
            ) : groupLike ? '等待发言' : '随时可以发消息'}
          </span>
          {groupLike && (
            <span className="floor-progress">
              <span className="floor-bar">
                <i style={{ width: `${Math.round((done / Math.max(1, thread.members.length)) * 100)}%` }} />
              </span>
              {done}/{thread.members.length}
            </span>
          )}
        </div>
        <footer
          className="composer"
          onDragOver={(event) => { event.preventDefault() }}
          onDrop={(event) => {
            event.preventDefault()
            void addFiles(event.dataTransfer.files)
          }}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              void addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          {pendingAttachments.length > 0 || uploading || attachError ? (
            <div className="attach-pending">
              {pendingAttachments.map((attachment) => (
                <span key={attachment.id} className="attach-chip">
                  {attachment.kind === 'image' ? <IconImage size={12} /> : <IconFile size={12} />}
                  <span className="attachment-name">{attachment.name}</span>
                  <button
                    type="button"
                    onClick={() => setPendingAttachments((prev) => prev.filter((item) => item.id !== attachment.id))}
                    aria-label="移除附件"
                  >×</button>
                </span>
              ))}
              {uploading ? <span className="attach-hint">上传中…</span> : null}
              {attachError ? <span className="attach-error">{attachError}</span> : null}
            </div>
          ) : null}
          {mentionChoices.length > 0 && (
            <div className="mention-menu" role="listbox" aria-label="点名">
              {mentionChoices.map((choice, i) => (
                <button
                  key={choice.key}
                  type="button"
                  role="option"
                  className={i === mentionIndex ? 'on' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    insertMention(choice.name)
                  }}
                >
                  <span>{choice.name === '全体' ? '@全体' : choice.name}</span>
                  <small>{choice.hint}</small>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={boxRef}
            value={draft}
            placeholder={empty && peer ? '发送消息…，输入 @ 点名' : groupLike ? '输入消息，@本群成员' : '发给这位角色，输入 @ 点名'}
            onChange={(e) => {
              setDraft(e.target.value)
              setMentionHi(0)
              rememberCaret(e.target)
            }}
            onSelect={(e) => rememberCaret(e.currentTarget)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files)
              if (files.length === 0) {
                for (const item of event.clipboardData.items) {
                  if (item.kind !== 'file') continue
                  const file = item.getAsFile()
                  if (file) files.push(file)
                }
              }
              if (files.length > 0) {
                event.preventDefault()
                void addFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (mentionChoices.length > 0 && e.key === 'ArrowDown') {
                e.preventDefault()
                setMentionHi((mentionIndex + 1) % mentionChoices.length)
                return
              }
              if (mentionChoices.length > 0 && e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionHi((mentionIndex - 1 + mentionChoices.length) % mentionChoices.length)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (mentionChoices.length > 0) {
                  insertMention(mentionChoices[mentionIndex].name)
                  return
                }
                sendDraft()
              }
            }}
          />
          <div className="bar">
            <button type="button" className="attach-btn" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <IconPaperclip size={14} />
              {uploading ? '上传中…' : '附件'}
            </button>
            <button type="button" onClick={sendDraft} disabled={uploading}>
              <IconSend size={13} />
              发送
            </button>
          </div>
        </footer>
      </section>
      {profilePersona ? (
        <PersonaProfile
          im={im}
          persona={profilePersona}
          thread={thread}
          onClose={onHideProfile}
          onEdit={() => onEditPersona(profilePersona)}
          onDelete={() => onDeletePersona(profilePersona)}
          models={models}
          onMessage={() => {
            const t = im.openDm(profilePersona.id, projectRoot)
            refresh()
            setDraft('')
            void t
          }}
          refresh={refresh}
          projectRoot={projectRoot}
        />
      ) : groupLike && !narrow ? (
        <GroupRightPane
          im={im}
          thread={thread}
          run={run}
          refresh={refresh}
          onShowProfile={onShowProfile}
          tab={rightTab}
          onTab={setRightTab}
          activityFilter={activityFilter}
          onActivityFilter={setActivityFilter}
          onOpenTrace={setTraceDetail}
        />
      ) : null}
      {overlayTab ? (
        <div
          className="ws-dialog-mask"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOverlayTab(null) }}
        >
          <div className="ws-dialog narrow-dialog" role="dialog" aria-label="群信息">
            <div className="ws-dialog-head">
              <h2>群信息</h2>
              <button type="button" className="ws-dialog-close" onClick={() => setOverlayTab(null)}>关闭</button>
            </div>
            <div className="right-tabs">
              <button type="button" className={overlayTab === 'members' ? 'on' : ''} onClick={() => setOverlayTab('members')}>成员</button>
              <button type="button" className={overlayTab === 'facts' ? 'on' : ''} onClick={() => setOverlayTab('facts')}>任务板</button>
              <button type="button" className={overlayTab === 'queue' ? 'on' : ''} onClick={() => setOverlayTab('queue')}>候选</button>
              <button type="button" className={overlayTab === 'activity' ? 'on' : ''} onClick={() => setOverlayTab('activity')}>执行</button>
              <button type="button" className={overlayTab === 'files' ? 'on' : ''} onClick={() => setOverlayTab('files')}>文件</button>
            </div>
            <div className="right-body">
              {rightContent(overlayTab, (personaId) => { setActivityFilter(personaId); setOverlayTab('activity') })}
            </div>
          </div>
        </div>
      ) : null}
      {filesOpen ? (
        <div
          className="ws-dialog-mask"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setFilesOpen(false) }}
        >
          <div className="ws-dialog files-dialog" role="dialog" aria-label={groupLike ? '群文件' : '会话文件'}>
            <div className="ws-dialog-head">
              <h2>{groupLike ? '群文件' : '会话文件'}</h2>
              <button type="button" className="ws-dialog-close" onClick={() => setFilesOpen(false)}>关闭</button>
            </div>
            <GroupFilesPane thread={thread} projectRoot={thread.projectRoot} />
          </div>
        </div>
      ) : null}
      {traceDetail ? (
        <div
          className="ws-dialog-mask"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setTraceDetail(null) }}
        >
          <div className="ws-dialog narrow-dialog" role="dialog" aria-label="执行记录">
            <div className="ws-dialog-head">
              <h2>{traceDetail.personaName} · 执行记录</h2>
              <button type="button" className="ws-dialog-close" onClick={() => setTraceDetail(null)}>关闭</button>
            </div>
            <div className="ws-dialog-body trace-detail">
              <div className="field-hint">
                {fmt(traceDetail.at)} · {Math.max(1, Math.round(traceDetail.ms / 1000))}s · {traceDetail.steps.length} 步
              </div>
              {traceDetail.steps.map((step) => (
                <div key={step.step} className="trace-step">
                  <div className="trace-step-head">
                    <b>#{step.step} {step.kind === 'reply' ? '回复' : traceToolLabel(step.name)}</b>
                    <span>{step.ok === false ? '失败' : '成功'}{typeof step.ms === 'number' ? ` · ${step.ms}ms` : ''}</span>
                  </div>
                  {step.args ? <div className="trace-args">参数：{step.args}</div> : null}
                  {step.result ? <div className="trace-result">{step.result}</div> : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}


