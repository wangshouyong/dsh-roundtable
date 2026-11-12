import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImService } from '../core/im.ts'
import type { ImState, Persona, Thread } from '../core/types.ts'
import type { TrashEntryMeta } from '../core/trash.ts'
import { findModel, type ModelCatalog } from '../host/models.ts'
import {
  addTrashEntry,
  forgetNativeSessions,
  loadTrash,
  purgeTrash,
  restoreTrashEntry,
  toolGroupsSnapshot,
} from './httpStore.ts'
import { draftFromPersona, PersonaEditor, type PersonaDraft } from './PersonaEditor.tsx'
import { SessionRow, GroupList, Contacts } from './im/lists.tsx'
import { Chat } from './im/chat.tsx'
import { ConfirmDialog, type ConfirmSpec } from './im/confirm.tsx'
import { TrashDialog } from './im/trash-dialog.tsx'
import { IconTrash } from './im/icons.tsx'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ConfirmRequest {
  spec: ConfirmSpec
  run: () => Promise<void>
}

export function ImApp(props: {
  im: ImService
  projectRoot: string
  models: ModelCatalog
  persist?: (state: ImState) => Promise<void>
}) {
  const { im, projectRoot, models, persist } = props
  const [, setTick] = useState(0)
  const persistTimer = useRef<number>(0)
  const refresh = () => {
    setTick((n) => n + 1)
    if (!persist) return
    window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      void persist(im.snapshot())
    }, 200)
  }
  // 异步事实抽取完成后重新渲染并触发落盘（抽取不阻塞回复）。
  useEffect(() => {
    im.onAsyncChange = refresh
    return () => {
      if (im.onAsyncChange === refresh) im.onAsyncChange = undefined
    }
  })
  // 主动私聊调度：每 60s 让 ImService 看一次有没有角色该来敲门（判定在 core/proactive.ts）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void im.tickProactive().then((result) => {
        if (result.fired) refresh()
      }).catch(() => undefined)
    }, 60_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [im])
  const [tab, setTab] = useState<'inbox' | 'groups' | 'contacts'>('inbox')
  // 进入面板默认落在“最近更新”的那条会话（和左侧列表第一行一致）。
  const initialThreadId = useMemo(
    () => [...im.state.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id,
    [im],
  )
  const [activeId, setActiveId] = useState<string | undefined>(initialThreadId)
  // 用户明确要求私聊时，ImService 会开小窗并通过这个回调把界面切过去。
  useEffect(() => {
    im.onDmOpened = (threadId) => {
      setActiveId(threadId)
      refresh()
    }
    return () => { im.onDmOpened = undefined }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [im])
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | undefined>()
  const [showProfile, setShowProfile] = useState(true)
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  const [editor, setEditor] = useState<null | { mode: 'create' } | { mode: 'edit'; persona: Persona }>(null)

  // ── 回收站 / 二次确认 / 轻提示 ─────────────────────────────────────────
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [trashEntries, setTrashEntries] = useState<TrashEntryMeta[]>([])
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashLoading, setTrashLoading] = useState(false)
  const [trashError, setTrashError] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const noticeTimer = useRef<number>(0)

  function showNotice(kind: 'ok' | 'error', text: string): void {
    window.clearTimeout(noticeTimer.current)
    setNotice({ kind, text })
    noticeTimer.current = window.setTimeout(() => setNotice(null), kind === 'error' ? 8000 : 5000)
  }
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  async function reloadTrash(): Promise<void> {
    setTrashLoading(true)
    try {
      setTrashEntries(await loadTrash(projectRoot))
      setTrashError('')
    } catch (error) {
      setTrashError(errorText(error))
    } finally {
      setTrashLoading(false)
    }
  }
  useEffect(() => {
    void reloadTrash()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runConfirm(action: () => Promise<void>): Promise<void> {
    if (confirmBusy) return
    setConfirmBusy(true)
    try {
      await action()
      setConfirm(null)
    } catch (error) {
      setConfirm(null)
      showNotice('error', errorText(error))
    } finally {
      setConfirmBusy(false)
    }
  }

  /** 删除/清空前必须先落盘：存不进去就整个取消，不留"界面删了、磁盘还在"的半状态。 */
  async function saveNow(): Promise<void> {
    if (!persist) throw new Error('当前环境没有落盘通道，删除/清空不会执行')
    await persist(im.snapshot())
  }

  function nextThreadId(removed: readonly string[]): string | undefined {
    return [...im.state.threads]
      .filter((thread) => !removed.includes(thread.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
  }

  function requestDeleteThread(thread: Thread): void {
    const isGroup = thread.kind === 'group'
    setConfirm({
      spec: {
        title: isGroup ? `解散群「${thread.title}」` : `删除会话「${thread.title}」`,
        description: isGroup
          ? '群会从会话列表移除，群数据（聊天记录、附件、任务板、产物）一起移入回收站。角色本身不会被删除。'
          : '会话会从列表移除，聊天记录与附件一起移入回收站。角色本身不会被删除。',
        confirmLabel: isGroup ? '解散群' : '删除会话',
        danger: true,
        bullets: ['可在左下角「回收站」里恢复；彻底删除前数据一直留着。'],
      },
      run: async () => {
        const plan = im.deleteThread(thread.id)
        try {
          await saveNow()
        } catch (error) {
          im.restoreThread(plan.snapshot)
          refresh()
          throw new Error('没存进磁盘，已取消删除：' + errorText(error))
        }
        try {
          await addTrashEntry({
            projectRoot,
            kind: 'thread',
            label: plan.label,
            detail: plan.detail,
            threadIds: [thread.id],
            payload: { thread: plan.snapshot },
          })
        } catch (error) {
          im.restoreThread(plan.snapshot)
          await saveNow().catch(() => undefined)
          refresh()
          throw new Error('数据目录没能移入回收站，已取消删除：' + errorText(error))
        }
        void forgetNativeSessions({ threadId: thread.id }).catch(() => undefined)
        if (activeId === thread.id) setActiveId(nextThreadId([thread.id]))
        await reloadTrash()
        refresh()
        showNotice('ok', `${isGroup ? '已解散' : '已删除'}「${plan.label}」，可在回收站恢复`)
      },
    })
  }

  function requestClearHistory(thread: Thread): void {
    setConfirm({
      spec: {
        title: `清空「${thread.title}」的聊天记录`,
        description: '会话保留，但全部消息、任务板事实、共识、执行轨迹和附件会移入回收站；线程记忆也会一起清掉。',
        confirmLabel: '清空聊天记录',
        danger: true,
        bullets: ['清空后如果又发了新消息，这条回收站记录只能彻底删除，不能恢复。'],
      },
      run: async () => {
        const plan = im.clearThreadHistory(thread.id)
        let entry: TrashEntryMeta
        try {
          entry = await addTrashEntry({
            projectRoot,
            kind: 'history',
            label: plan.label,
            detail: plan.detail,
            threadIds: [thread.id],
            payload: { thread: plan.snapshot, memories: plan.memories, wakeExcerpts: plan.wakeExcerpts },
            replaceOnRestore: true,
          })
        } catch (error) {
          im.restoreThreadHistory(plan.snapshot, plan)
          refresh()
          throw new Error('数据目录没能移入回收站，已取消清空：' + errorText(error))
        }
        try {
          await saveNow()
        } catch (error) {
          await restoreTrashEntry(entry.id, projectRoot).catch(() => undefined)
          im.restoreThreadHistory(plan.snapshot, plan)
          refresh()
          throw new Error('没存进磁盘，已取消清空：' + errorText(error))
        }
        void forgetNativeSessions({ threadId: thread.id }).catch(() => undefined)
        await reloadTrash()
        refresh()
        showNotice('ok', `已清空「${plan.label}」的聊天记录，可在回收站恢复`)
      },
    })
  }

  function requestDeletePersona(persona: Persona): void {
    setConfirm({
      spec: {
        title: `删除角色「${persona.name}」`,
        description: '角色会从通讯录删除；它的私聊/三人小窗会话一起移入回收站；所在群的历史消息保留，但会把该角色移出成员。',
        confirmLabel: '删除角色',
        danger: true,
        bullets: ['可在「回收站」恢复角色、会话和群成员位置。'],
      },
      run: async () => {
        const plan = im.deletePersona(persona.id)
        try {
          await saveNow()
        } catch (error) {
          im.restorePersona(plan)
          refresh()
          throw new Error('没存进磁盘，已取消删除：' + errorText(error))
        }
        try {
          await addTrashEntry({
            projectRoot,
            kind: 'persona',
            label: plan.label,
            detail: plan.detail,
            threadIds: plan.threads.map((thread) => thread.id),
            payload: {
              persona: plan.persona,
              threads: plan.threads,
              memberships: plan.memberships,
              memories: plan.memories,
              wakeExcerpts: plan.wakeExcerpts,
            },
          })
        } catch (error) {
          im.restorePersona(plan)
          await saveNow().catch(() => undefined)
          refresh()
          throw new Error('数据目录没能移入回收站，已取消删除：' + errorText(error))
        }
        void forgetNativeSessions({ personaId: persona.id }).catch(() => undefined)
        if (selectedPersonaId === persona.id) {
          setSelectedPersonaId(undefined)
          setShowProfile(false)
        }
        const removed = plan.threads.map((thread) => thread.id)
        if (activeId && removed.includes(activeId)) setActiveId(nextThreadId(removed))
        await reloadTrash()
        refresh()
        showNotice('ok', `已删除角色「${plan.label}」，可在回收站恢复`)
      },
    })
  }

  async function doRestore(entry: TrashEntryMeta): Promise<void> {
    if (entry.kind === 'history') {
      const current = im.state.threads.find((thread) => thread.id === entry.threadIds[0])
      if (!current) throw new Error('会话已经不在了，这条回收站记录只能彻底删除')
      if (current.messages.length > 0) {
        throw new Error('这个会话清空后又有新消息，不能直接恢复；可先删除会话再恢复，或放弃这条记录')
      }
    }
    const restored = await restoreTrashEntry(entry.id, projectRoot)
    let message = `已恢复「${entry.label}」`
    if (entry.kind === 'thread' && restored.payload.thread) {
      const thread = im.restoreThread(restored.payload.thread)
      setActiveId(thread.id)
    } else if (entry.kind === 'history' && restored.payload.thread) {
      im.restoreThreadHistory(restored.payload.thread, restored.payload)
    } else if (entry.kind === 'persona') {
      const result = im.restorePersona(restored.payload)
      const skipped = result.skippedThreadIds.length + result.skippedMembershipThreadIds.length
      message = skipped
        ? `已恢复角色「${result.persona.name}」与 ${result.threads.length} 个会话；${skipped} 个会话/群已不存在，跳过`
        : `已恢复角色「${result.persona.name}」`
    }
    try {
      await saveNow()
    } catch (error) {
      throw new Error('已从回收站恢复，但没存进磁盘：' + errorText(error))
    }
    await reloadTrash()
    refresh()
    showNotice('ok', message)
  }

  function requestRestore(entry: TrashEntryMeta): void {
    setConfirm({
      spec: {
        title: `恢复「${entry.label}」`,
        description: entry.kind === 'persona'
          ? '角色、它被连带删除的会话、群成员位置会一起恢复。'
          : entry.kind === 'history'
            ? '把这个会话清空前的聊天记录写回去（只在会话仍为空时可用）。'
            : '会话会回到会话列表，聊天记录与附件一起恢复。',
        confirmLabel: '恢复',
        bullets: [entry.detail || '无详情'],
      },
      run: async () => { await doRestore(entry) },
    })
  }

  function requestPurge(entry: TrashEntryMeta): void {
    setConfirm({
      spec: {
        title: `彻底删除「${entry.label}」`,
        description: '彻底删除会物理删掉回收站里的这份数据目录，之后无法恢复。',
        confirmLabel: '彻底删除',
        danger: true,
      },
      run: async () => {
        await purgeTrash(entry.id, projectRoot)
        await reloadTrash()
        showNotice('ok', `已彻底删除「${entry.label}」`)
      },
    })
  }

  function requestPurgeAll(): void {
    setConfirm({
      spec: {
        title: '清空回收站',
        description: `会彻底删除回收站里的 ${trashEntries.length} 项数据，之后无法恢复。`,
        confirmLabel: '清空回收站',
        danger: true,
      },
      run: async () => {
        const result = await purgeTrash(undefined, projectRoot)
        await reloadTrash()
        if (result.failed.length > 0) {
          throw new Error(`有 ${result.failed.length} 项没删掉（${result.failed.join('、')}），其余已删除`)
        }
        showNotice('ok', `已清空回收站（${result.purged} 项）`)
      },
    })
  }

  function savePersona(input: PersonaDraft, existing?: Persona) {
    const picked = findModel(models, input.model)
    const duties = input.duties.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
    const payload = {
      name: input.name.trim(),
      avatar: input.avatar || input.name.trim().slice(0, 1),
      avatarUrl: input.avatarUrl,
      personality: input.personality.trim() || '协作者',
      duties: duties.length ? duties : ['协作'],
      model: input.model,
      provider: picked?.provider,
      proactiveDm: input.proactiveDm,
      defaultActivity: input.defaultActivity,
      toolAllow: input.toolAllow,
    }
    const p = existing ? im.updatePersona(existing.id, payload) : im.createPersona({ ...payload, origin: 'mine' })
    setEditor(null)
    openPersona(p)
  }

  const thread = im.state.threads.find((t) => t.id === activeId)
  const sessions = useMemo(
    () => [...im.state.threads]
      .filter((t) => t.title.includes(q) || (t.messages.at(-1)?.text.includes(q) ?? false))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [im.state.threads, q, im.state.threads.map((t) => t.updatedAt).join()],
  )

  // 群共识自动生成：只在**切到某个群**时补一次（有事实但还没共识/共识落后）。
  // 不跟 updatedAt/version 走，否则一轮里消息变化会反复触发 curate（实测重复调用、拖慢面板）。
  useEffect(() => {
    if (!thread || !im.consensusEnabled) return
    im.ensureConsensus(thread.id)
  }, [im, thread?.id])

  async function run(fn: () => Promise<unknown> | unknown) {
    await fn()
    refresh()
  }

  function openPersona(p: Persona) {
    const t = im.openDm(p.id, projectRoot)
    setSelectedPersonaId(p.id)
    setActiveId(t.id)
    setShowProfile(true)
    refresh()
  }

  function openThread(t: Thread) {
    t.unread = 0
    setActiveId(t.id)
    setSelectedPersonaId(t.kind === 'dm' ? t.memberIds[0] : undefined)
    setShowProfile(t.kind === 'dm')
    refresh()
  }

  const profilePersona = selectedPersonaId
    ? im.state.personas.find((p) => p.id === selectedPersonaId)
    : thread?.kind === 'dm'
      ? im.state.personas.find((p) => p.id === thread.memberIds[0])
      : undefined

  return (
    <>
      <div className="work">
        <section className="col-inbox">
          <div className="tabs">
            <button className={tab === 'inbox' ? 'on' : ''} onClick={() => setTab('inbox')}>消息</button>
            <button className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>群</button>
            <button
              className={tab === 'contacts' ? 'on' : ''}
              onClick={() => {
                setTab('contacts')
                const first = im.state.personas[0]
                if (first && !selectedPersonaId) openPersona(first)
              }}
            >
              通讯录
            </button>
          </div>
          {tab === 'inbox' ? (
            <div className="rows">
              <input className="search" placeholder="搜索聊天记录" value={q} onChange={(e) => setQ(e.target.value)} />
              {sessions.length === 0 && <div className="empty">还没有聊天。从通讯录找人，或到「群」里进群。</div>}
              {sessions.map((t, i) => (
                <SessionRow
                  key={t.id}
                  thread={t}
                  index={i}
                  active={t.id === activeId}
                  im={im}
                  onOpen={openThread}
                  onClearHistory={requestClearHistory}
                  onDeleteThread={requestDeleteThread}
                />
              ))}
            </div>
          ) : tab === 'groups' ? (
            <GroupList
              im={im}
              q={q}
              setQ={setQ}
              activeId={activeId}
              onOpen={(t) => { openThread(t); setTab('groups') }}
              onCreate={() => setTab('contacts')}
              onClearHistory={requestClearHistory}
              onDeleteThread={requestDeleteThread}
            />
          ) : (
            <Contacts
              im={im}
              q={q}
              setQ={setQ}
              projectRoot={projectRoot}
              selectedPersonaId={selectedPersonaId}
              onPersona={openPersona}
              onThread={(t) => { openThread(t); setTab('groups') }}
              onCreate={() => setEditor({ mode: 'create' })}
              models={models}
            />
          )}
          <button
            type="button"
            className="trash-entry"
            title="删除的会话/群/角色和被清空的聊天记录都在这里，可恢复或彻底删除"
            onClick={() => { setTrashOpen(true); void reloadTrash() }}
          >
            <IconTrash size={14} />
            回收站{trashEntries.length > 0 ? `（${trashEntries.length}）` : ''}
          </button>
        </section>
        {editor && (
          <PersonaEditor
            title={editor.mode === 'create' ? '新建角色' : '编辑角色'}
            catalog={models}
            initial={editor.mode === 'edit' ? draftFromPersona(editor.persona) : undefined}
            toolCatalog={toolGroupsSnapshot()}
            onClose={() => setEditor(null)}
            onSave={(d) => savePersona(d, editor.mode === 'edit' ? editor.persona : undefined)}
          />
        )}
        {thread ? (
          <Chat
            im={im}
            thread={thread}
            draft={draft}
            setDraft={setDraft}
            run={run}
            profilePersona={showProfile ? profilePersona : undefined}
            onShowProfile={(id) => { setSelectedPersonaId(id); setShowProfile(true) }}
            onHideProfile={() => setShowProfile(false)}
            onEditPersona={(p) => setEditor({ mode: 'edit', persona: p })}
            onDeletePersona={requestDeletePersona}
            onClearThreadHistory={requestClearHistory}
            onDeleteThread={requestDeleteThread}
            projectRoot={projectRoot}
            refresh={refresh}
            models={models}
          />
        ) : (
          <div className="col-chat"><div className="empty">从通讯录建角色或拉群</div></div>
        )}
      </div>
      {trashOpen ? (
        <TrashDialog
          entries={trashEntries}
          loading={trashLoading}
          busy={confirmBusy}
          error={trashError || undefined}
          onClose={() => { if (!confirmBusy) setTrashOpen(false) }}
          onRestore={requestRestore}
          onPurge={requestPurge}
          onPurgeAll={requestPurgeAll}
        />
      ) : null}
      {/* 确认弹窗必须渲染在回收站弹窗之后：两个都用 z-index 20 的 fixed 遮罩，后渲染的在上面。 */}
      {confirm ? (
        <ConfirmDialog
          spec={confirm.spec}
          busy={confirmBusy}
          onCancel={() => { if (!confirmBusy) setConfirm(null) }}
          onConfirm={() => { void runConfirm(confirm.run) }}
        />
      ) : null}
      {notice ? <div className={`toast ${notice.kind}`} role="status">{notice.text}</div> : null}
    </>
  )
}
