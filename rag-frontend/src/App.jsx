import { useState, useRef, useCallback, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import './App.css'

const API = import.meta.env.VITE_API_URL || "http://localhost:8000"

// ── Icons ──────────────────────────────────────────────────────────────────
const UploadIcon = () => (
  <svg className="upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
  </svg>
)
const FileIcon = () => (
  <svg className="file-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
)
const RemoveIcon = () => (
  <svg className="file-remove" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
)
const ChatIcon = () => (
  <svg className="chat-empty-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
)
const SourceIcon = () => (
  <svg className="source-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
)

// ── Helpers ────────────────────────────────────────────────────────────────
function evalColor(score) {
  if (score >= 0.8) return 'eval-badge--high'
  if (score >= 0.5) return 'eval-badge--mid'
  return 'eval-badge--low'
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function generateId() {
  return Math.random().toString(36).substring(2, 9)
}
function createNewSession() {
  return { id: generateId(), name: 'New chat', createdAt: new Date().toISOString(), fileNames: [], history: [] }
}

// ── App ────────────────────────────────────────────────────────────────────
function App() {
  // Sessions persisted in localStorage
  const [sessions, setSessions] = useState(() => {
    try {
      const saved = localStorage.getItem('rag-sessions')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch {}
    return [createNewSession()]
  })

  const [activeSessionId, setActiveSessionId] = useState(() => {
    try { return localStorage.getItem('rag-active-session') } catch { return null }
  })

  // Global file registry: filename → { status, size }
  // Shared across sessions so we never re-index the same file twice
  const [globalFiles, setGlobalFiles] = useState({})

  // UI state
  const [question, setQuestion]       = useState('')
  const [isLoading, setIsLoading]     = useState(false)
  const [isDragOver, setIsDragOver]   = useState(false)
  const [showDashboard, setShowDashboard] = useState(false)
  const [dashboardData, setDashboardData] = useState(null)

  // Refs
  const fileInputRef        = useRef(null)
  const chatEndRef          = useRef(null)
  const abortControllerRef  = useRef(null)
  const scrollTimerRef      = useRef(null)
  const pendingIdRef        = useRef(null)
  const isLoadingRef        = useRef(false)
  const currentQuestionRef  = useRef('')
  const pollingRef          = useRef({})
  const historyRef          = useRef([])
  const historyIndexRef     = useRef(-1)
  const draftQuestionRef    = useRef('')

  // Derived
  const activeSession    = sessions.find(s => s.id === activeSessionId) || sessions[0]
  const history          = activeSession?.history    || []
  const sessionFileNames = activeSession?.fileNames  || []
  const sessionFiles     = sessionFileNames.map(name => ({
    name, id: name,
    status: globalFiles[name]?.status || 'ready',
    size:   globalFiles[name]?.size   || 0,
  }))
  const anyIndexing = sessionFiles.some(f => f.status === 'indexing' || f.status === 'uploading')

  // Keep historyRef in sync (fixes stale-closure issue in handleSubmit)
  useEffect(() => { historyRef.current = history }, [history])

  // Persist sessions
  useEffect(() => { localStorage.setItem('rag-sessions', JSON.stringify(sessions)) }, [sessions])
  useEffect(() => {
    if (activeSession?.id) localStorage.setItem('rag-active-session', activeSession.id)
  }, [activeSession?.id])

  // ── Session helpers ───────────────────────────────────────────────────
  const updateHistory = useCallback((updater) => {
    const sid = activeSession?.id
    setSessions(prev => prev.map(s =>
      s.id === sid
        ? { ...s, history: typeof updater === 'function' ? updater(s.history) : updater }
        : s
    ))
  }, [activeSession?.id])

  const createSession = useCallback(() => {
    // Don't create a new session if the current one is already empty
    if (activeSession && activeSession.history.length === 0 && activeSession.fileNames.length === 0) {
      setActiveSessionId(activeSession.id)
      return
    }
    const s = createNewSession()
    setSessions(prev => [s, ...prev])
    setActiveSessionId(s.id)
    setQuestion('')
  }, [activeSession])

  const switchSession = useCallback((id) => {
    // Cancel any in-flight request
    if (isLoadingRef.current) {
      const cancelledId = pendingIdRef.current
      pendingIdRef.current = null
      isLoadingRef.current = false
      setIsLoading(false)
      if (abortControllerRef.current) { abortControllerRef.current.abort(); abortControllerRef.current = null }
      if (cancelledId) {
        setSessions(prev => prev.map(s => ({ ...s, history: s.history.filter(e => e.id !== cancelledId) })))
      }
    }
    setActiveSessionId(id)
    setQuestion('')
    historyIndexRef.current = -1
    draftQuestionRef.current = ''
  }, [])

  const deleteSession = useCallback((id) => {
    setSessions(prev => {
      const remaining = prev.filter(s => s.id !== id)
      if (remaining.length === 0) {
        const fresh = createNewSession()
        setActiveSessionId(fresh.id)
        return [fresh]
      }
      if (activeSession?.id === id) setActiveSessionId(remaining[0].id)
      return remaining
    })
  }, [activeSession?.id])

  const addFileToSession = useCallback((filename) => {
    const sid = activeSession?.id
    setSessions(prev => prev.map(s => {
      if (s.id !== sid || s.fileNames.includes(filename)) return s
      // Auto-name session from filename if still untitled and no messages yet
      const shouldRename = s.name === 'New chat' && s.history.length === 0
      const nameFromFile = filename.replace(/\.[^/.]+$/, '') // strip extension
      const name = shouldRename
        ? (nameFromFile.length > 35 ? nameFromFile.slice(0, 35) + '…' : nameFromFile)
        : s.name
      return { ...s, name, fileNames: [...s.fileNames, filename] }
    }))
  }, [activeSession?.id])

  // ── Prompt history navigation (arrow keys) ───────────────────────────
  const handleInputKeyDown = useCallback((e) => {
    if (isLoadingRef.current) return
    const completed = historyRef.current.filter(h => h.answer !== null)
    if (completed.length === 0) return
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (historyIndexRef.current === -1) draftQuestionRef.current = e.target.value
      const next = Math.min(historyIndexRef.current + 1, completed.length - 1)
      historyIndexRef.current = next
      setQuestion(completed[completed.length - 1 - next].question)
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndexRef.current === -1) return
      const next = historyIndexRef.current - 1
      historyIndexRef.current = next
      setQuestion(next === -1 ? draftQuestionRef.current : completed[completed.length - 1 - next].question)
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // ── Load existing indexed docs on startup ────────────────────────────
  useEffect(() => {
    fetch(`${API}/documents`)
      .then(r => r.json())
      .then(docs => {
        const registry = {}
        docs.forEach(d => { registry[d.name] = { status: d.status || 'ready', size: 0 } })
        setGlobalFiles(registry)
      })
      .catch(() => {})
  }, [])

  // ── Poll indexing status ──────────────────────────────────────────────
  const pollStatus = useCallback((filename) => {
    if (pollingRef.current[filename]) return
    pollingRef.current[filename] = setInterval(async () => {
      try {
        const res  = await fetch(`${API}/status/${encodeURIComponent(filename)}`)
        const data = await res.json()
        if (data.status === 'ready' || data.status === 'error') {
          clearInterval(pollingRef.current[filename])
          delete pollingRef.current[filename]
          setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: data.status } }))
        }
      } catch {
        clearInterval(pollingRef.current[filename])
        delete pollingRef.current[filename]
      }
    }, 2000)
  }, [])

  useEffect(() => () => Object.values(pollingRef.current).forEach(clearInterval), [])

  // ── Upload ────────────────────────────────────────────────────────────
  const uploadToBackend = useCallback(async (file) => {
    const fd = new FormData()
    fd.append("file", file)
    const res = await fetch(`${API}/upload`, { method: "POST", body: fd })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    return res.json()
  }, [])

  const handleFileSelect = useCallback(async (selectedFiles) => {
    const valid = Array.from(selectedFiles).filter(f => {
      const ext = f.name.split('.').pop().toLowerCase()
      return f.type === 'application/pdf' || f.type.startsWith('image/') ||
        f.type === 'text/plain' || ext === 'txt' || ext === 'docx' ||
        f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    for (const f of valid) {
      // Already indexed globally → just link to this session, no re-upload
      if (globalFiles[f.name]?.status === 'ready') {
        addFileToSession(f.name)
        continue
      }
      // Already indexing → link and let polling handle it
      if (globalFiles[f.name]?.status === 'indexing') {
        addFileToSession(f.name)
        pollStatus(f.name)
        continue
      }
      // New file → upload, register, link
      setGlobalFiles(prev => ({ ...prev, [f.name]: { status: 'uploading', size: f.size } }))
      addFileToSession(f.name)
      try {
        const result = await uploadToBackend(f)
        setGlobalFiles(prev => ({ ...prev, [f.name]: { ...prev[f.name], status: result.status } }))
        if (result.status === 'indexing') pollStatus(f.name)
      } catch {
        setGlobalFiles(prev => ({ ...prev, [f.name]: { ...prev[f.name], status: 'error' } }))
      }
    }
  }, [globalFiles, addFileToSession, uploadToBackend, pollStatus])

  // ── Remove file ───────────────────────────────────────────────────────
  const handleRemoveFile = useCallback(async (filename) => {
    const sid = activeSession?.id
    // Unlink from current session
    setSessions(prev => prev.map(s =>
      s.id === sid ? { ...s, fileNames: s.fileNames.filter(n => n !== filename) } : s
    ))
    // Delete from server only if no other session uses it
    const otherUses = sessions.some(s => s.id !== sid && s.fileNames.includes(filename))
    if (!otherUses) {
      try {
        await fetch(`${API}/documents/${encodeURIComponent(filename)}`, { method: "DELETE" })
        setGlobalFiles(prev => { const n = { ...prev }; delete n[filename]; return n })
      } catch (e) { console.error("Delete failed:", e) }
    }
  }, [activeSession?.id, sessions])

  // ── Cancel indexing ───────────────────────────────────────────────────
  const handleCancelIndexing = useCallback(async (filename) => {
    try {
      await fetch(`${API}/cancel/${encodeURIComponent(filename)}`, { method: "POST" })
      if (pollingRef.current[filename]) { clearInterval(pollingRef.current[filename]); delete pollingRef.current[filename] }
      const sid = activeSession?.id
      setSessions(prev => prev.map(s =>
        s.id === sid ? { ...s, fileNames: s.fileNames.filter(n => n !== filename) } : s
      ))
      setGlobalFiles(prev => { const n = { ...prev }; delete n[filename]; return n })
    } catch (e) { console.error("Cancel failed:", e) }
  }, [activeSession?.id])

  // ── Cancel response ───────────────────────────────────────────────────
  const handleCancel = useCallback((e) => {
    if (e?.preventDefault) e.preventDefault()
    if (scrollTimerRef.current) { clearTimeout(scrollTimerRef.current); scrollTimerRef.current = null }
    const cancelledId = pendingIdRef.current
    pendingIdRef.current = null
    isLoadingRef.current = false
    if (cancelledId) {
      setSessions(prev => prev.map(s => ({ ...s, history: s.history.filter(h => h.id !== cancelledId) })))
    }
    setQuestion(currentQuestionRef.current)
    setIsLoading(false)
    if (abortControllerRef.current) { abortControllerRef.current.abort(); abortControllerRef.current = null }
  }, [])

  // ── Submit ────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (e) => {
    e.preventDefault()
    if (!question.trim() || isLoadingRef.current) return

    const currentQuestion = question.trim()
    currentQuestionRef.current = currentQuestion
    historyIndexRef.current    = -1
    draftQuestionRef.current   = ''
    isLoadingRef.current       = true
    setIsLoading(true)
    setQuestion('')

    abortControllerRef.current = new AbortController()
    const tempId = generateId()
    pendingIdRef.current = tempId

    updateHistory(prev => [...prev, { id: tempId, question: currentQuestion, answer: null, sources: [], warning: null }])
    scrollTimerRef.current = setTimeout(scrollToBottom, 100)

    const sid = activeSession?.id
    const isFirstMessage = activeSession?.history.length === 0

    try {
      const res = await fetch(`${API}/ask`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: currentQuestion,
          history:  historyRef.current
            .filter(e => e.answer !== null && !e.answer.startsWith('Error:'))
            .map(e => ({ question: e.question, answer: e.answer })),
          files: sessionFileNames,  // session-scoped retrieval
        }),
        signal: abortControllerRef.current.signal
      })

      if (!pendingIdRef.current) return
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || `Server error: ${res.status}`)
      }

      // Stream SSE tokens
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let scrolledOnFirst = false

      while (true) {
        if (!pendingIdRef.current) { reader.cancel(); break }
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw) continue
          let data; try { data = JSON.parse(raw) } catch { continue }

          if (data.type === 'token' && data.content) {
            updateHistory(prev => prev.map(entry =>
              entry.id === tempId ? { ...entry, answer: (entry.answer ?? '') + data.content } : entry
            ))
            if (!scrolledOnFirst) { scrolledOnFirst = true; scrollTimerRef.current = setTimeout(scrollToBottom, 100) }
          } else if (data.type === 'done') {
            updateHistory(prev => prev.map(entry =>
              entry.id === tempId
                ? { ...entry, answer: (entry.answer ?? '').trim(), sources: data.sources || [], warning: data.warning || null }
                : entry
            ))
            scrollTimerRef.current = setTimeout(scrollToBottom, 100)
            // Generate a short title from the first message in the background
            if (isFirstMessage) {
              fetch(`${API}/title`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: currentQuestion, files: sessionFileNames })
              })
                .then(r => r.json())
                .then(({ title }) => {
                  if (title) setSessions(prev => prev.map(s => s.id === sid ? { ...s, name: title } : s))
                })
                .catch(() => {})
            }
          } else if (data.type === 'eval') {
            setSessions(prev => prev.map(s => ({
              ...s,
              history: s.history.map(entry =>
                entry.id === tempId
                  ? { ...entry, eval: { faithfulness: data.faithfulness, answer_relevance: data.answer_relevance } }
                  : entry
              )
            })))
          } else if (data.type === 'error') {
            throw new Error(data.message)
          }
        }
      }

    } catch (err) {
      if (!pendingIdRef.current) return
      setQuestion(currentQuestionRef.current)
      updateHistory(prev => prev.map(entry =>
        entry.id === tempId ? { ...entry, answer: `Error: ${err.message}` } : entry
      ))
    } finally {
      if (pendingIdRef.current === tempId) {
        pendingIdRef.current = null
        isLoadingRef.current = false
        setIsLoading(false)
        abortControllerRef.current = null
      }
    }
  }, [question, scrollToBottom, updateHistory, sessionFileNames, activeSession])

  // ── Dashboard ─────────────────────────────────────────────────────────
  const openDashboard = useCallback(async () => {
    setShowDashboard(true)
    try { const res = await fetch(`${API}/dashboard`); setDashboardData(await res.json()) }
    catch { setDashboardData(null) }
  }, [])

  const getStatusBadge = (status) => {
    switch (status) {
      case 'uploading': return { label: 'Uploading...', color: 'var(--text-muted)' }
      case 'indexing':  return { label: 'Indexing...', color: '#854F0B' }
      case 'ready':     return { label: 'Ready', color: '#3B6D11' }
      case 'error':     return { label: 'Error', color: '#e53e3e' }
      default:          return null
    }
  }

  const totalQuestions = sessions.reduce((acc, s) => acc + s.history.filter(e => e.answer !== null).length, 0)

  const evalEntries = sessions.flatMap(s => s.history.filter(e => e.eval))
  const avgFaithfulness = evalEntries.length
    ? evalEntries.reduce((a, e) => a + e.eval.faithfulness, 0) / evalEntries.length
    : null
  const avgRelevance = evalEntries.length
    ? evalEntries.reduce((a, e) => a + e.eval.answer_relevance, 0) / evalEntries.length
    : null

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <nav className="navbar">
        <div className="navbar-logo">RAG Assistant</div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '16px' }}>
          {anyIndexing && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Indexing documents...</span>}
          <button className="clear-history-btn" onClick={openDashboard}>Stats</button>
          {history.filter(e => e.answer !== null).length > 0 && (
            <button className="clear-history-btn" onClick={() => window.print()}>Export PDF</button>
          )}
        </div>
      </nav>

      <div className="main-container">
        {/* ── Sessions sidebar (left) ── */}
        <aside className="sidebar-sessions">
          <button className="new-chat-btn" onClick={createSession}>＋ New chat</button>

          <div className="session-list">
            {sessions.map(s => (
              <div
                key={s.id}
                className={`session-item ${s.id === activeSession?.id ? 'active' : ''}`}
                onClick={() => switchSession(s.id)}
              >
                <div className="session-info">
                  <div className="session-name" title={s.name}>{s.name}</div>
                  <div className="session-meta">
                    {s.fileNames.length} file{s.fileNames.length !== 1 ? 's' : ''} &middot;{' '}
                    {s.history.filter(h => h.answer).length} msg{s.history.filter(h => h.answer).length !== 1 ? 's' : ''}
                  </div>
                </div>
                <button
                  className="session-delete"
                  onClick={ev => { ev.stopPropagation(); if (window.confirm('Delete this chat?')) deleteSession(s.id) }}
                  title="Delete session"
                >✕</button>
              </div>
            ))}
          </div>
        </aside>

        <main className="chat-area">
          <div className="print-header">
            <div className="print-header-title">RAG Assistant — Chat Export</div>
            <div className="print-header-date">{new Date().toLocaleString()}</div>
          </div>

          <div className="chat-messages">
            {history.length === 0 && !isLoading && (
              <div className="chat-empty">
                <ChatIcon />
                <h3 className="chat-empty-title">Start a conversation</h3>
                <p className="chat-empty-text">Upload documents and ask questions to get answers with source citations.</p>
              </div>
            )}

            {history.map(entry => (
              <div key={entry.id} className="conversation-entry">
                <div className="message-wrapper user">
                  <div className="message user">
                    <p className="message-content">{entry.question}</p>
                  </div>
                </div>
                <div className="message-wrapper ai">
                  <div className="message ai">
                    {entry.answer === null ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div className="loading-dots">
                          <div className="loading-dot" /><div className="loading-dot" /><div className="loading-dot" />
                        </div>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          {anyIndexing ? 'Waiting for indexing to finish…' : 'Generating a response…'}
                        </span>
                      </div>
                    ) : (
                      <div className="message-content markdown-body">
                        <ReactMarkdown>{entry.answer}</ReactMarkdown>
                      </div>
                    )}
                  </div>
                  {entry.warning && (
                    <p style={{ fontSize: '12px', color: '#854F0B', margin: '6px 0 0', padding: '6px 10px', background: '#FAEEDA', borderRadius: '6px' }}>
                      ⚠ {entry.warning}
                    </p>
                  )}
                  {entry.sources?.length > 0 && entry.answer !== null && (
                    <div className="sources">
                      {entry.sources.map((src, i) => (
                        <span key={i} className="source-pill"><SourceIcon />{src}</span>
                      ))}
                    </div>
                  )}
                  {entry.eval && entry.answer !== null && (
                    <div className="eval-scores">
                      <span className={`eval-badge ${evalColor(entry.eval.faithfulness)}`}
                        title="Faithfulness — how well the answer is grounded in the retrieved context">
                        F {Math.round(entry.eval.faithfulness * 100)}%
                      </span>
                      <span className={`eval-badge ${evalColor(entry.eval.answer_relevance)}`}
                        title="Answer relevance — how directly the answer addresses the question">
                        R {Math.round(entry.eval.answer_relevance * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <form className="input-bar" onSubmit={handleSubmit}>
            <div className="input-container">
              <input
                type="text" className="input-field"
                placeholder="Ask a question about your documents..."
                value={question} onChange={e => setQuestion(e.target.value)}
                onKeyDown={handleInputKeyDown} disabled={isLoading}
              />
              {isLoading
                ? <button key="cancel" type="button" className="cancel-button" onClick={handleCancel}>Cancel</button>
                : <button key="send"   type="submit"  className="send-button"   disabled={!question.trim()}>Send</button>
              }
            </div>
          </form>
        </main>

        {/* ── Files sidebar (right) ── */}
        <aside className="sidebar-files">
          <h2 className="sidebar-title">Documents</h2>

          <div
            className={`upload-zone ${isDragOver ? 'dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={ev => { ev.preventDefault(); setIsDragOver(false); handleFileSelect(ev.dataTransfer.files) }}
            onDragOver={ev => { ev.preventDefault(); setIsDragOver(true) }}
            onDragLeave={ev => { ev.preventDefault(); setIsDragOver(false) }}
          >
            <UploadIcon />
            <p className="upload-text">Click or drag to upload</p>
            <p className="upload-hint">PDF, Word, TXT or images</p>
            <input
              ref={fileInputRef} type="file" accept=".pdf,.txt,.docx,image/*" multiple
              style={{ display: 'none' }}
              onChange={ev => { handleFileSelect(ev.target.files); ev.target.value = '' }}
            />
          </div>

          {sessionFiles.length > 0 && (
            <div className="file-list">
              {sessionFiles.map(file => {
                const badge = getStatusBadge(file.status)
                return (
                  <div
                    key={file.name}
                    className={`file-item ${file.status === 'ready' ? 'file-item--clickable' : ''}`}
                    onClick={() => { if (file.status === 'ready') window.open(`${API}/files/${encodeURIComponent(file.name)}`, '_blank') }}
                  >
                    <FileIcon />
                    <div className="file-info">
                      <div className="file-name">{file.name}</div>
                      <div className="file-size" style={{ color: badge?.color }}>
                        {badge ? badge.label : formatFileSize(file.size)}
                      </div>
                    </div>
                    {file.status === 'ready' && (
                      <div onClick={ev => { ev.stopPropagation(); handleRemoveFile(file.name) }} style={{ cursor: 'pointer' }}>
                        <RemoveIcon />
                      </div>
                    )}
                    {(file.status === 'indexing' || file.status === 'uploading') && (
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                          {[0, 1, 2].map(i => (
                            <div key={i} style={{
                              width: '4px', height: '4px', borderRadius: '50%',
                              background: 'var(--text-muted)',
                              animation: `loading-pulse 1.2s infinite ${i * 0.2}s`
                            }} />
                          ))}
                        </div>
                        {file.status === 'indexing' && (
                          <span onClick={() => handleCancelIndexing(file.name)} style={{
                            fontSize: '11px', color: '#854F0B', cursor: 'pointer', textDecoration: 'underline'
                          }}>cancel</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </aside>
      </div>

      {/* ── Dashboard modal ── */}
      {showDashboard && (
        <div className="dashboard-overlay" onClick={() => setShowDashboard(false)}>
          <div className="dashboard-modal" onClick={e => e.stopPropagation()}>
            <div className="dashboard-header">
              <h2 className="dashboard-title">Usage Stats</h2>
              <button className="dashboard-close" onClick={() => setShowDashboard(false)}>✕</button>
            </div>
            {!dashboardData ? <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading…</p> : (
              <>
                <div className="dashboard-cards">
                  {[
                    { label: 'Questions asked',  value: totalQuestions },
                    { label: 'Documents ready',  value: dashboardData.documents.ready },
                    { label: 'Total chunks',     value: dashboardData.chunks.total },
                    { label: 'Chunks per query', value: dashboardData.config.similarity_top_k },
                  ].map(({ label, value }) => (
                    <div key={label} className="dashboard-card">
                      <div className="dashboard-card-value">{value}</div>
                      <div className="dashboard-card-label">{label}</div>
                    </div>
                  ))}
                </div>

                {evalEntries.length > 0 && (
                  <div className="dashboard-section">
                    <h3 className="dashboard-section-title">RAG quality (avg over {evalEntries.length} response{evalEntries.length !== 1 ? 's' : ''})</h3>
                    <div className="dashboard-cards" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      {[
                        { label: 'Avg faithfulness', value: avgFaithfulness, title: 'How well answers are grounded in retrieved context' },
                        { label: 'Avg relevance',    value: avgRelevance,    title: 'How directly answers address the questions' },
                      ].map(({ label, value, title }) => (
                        <div key={label} className="dashboard-card" title={title}>
                          <div className={`dashboard-card-value eval-score-value ${evalColor(value)}`}>
                            {Math.round(value * 100)}%
                          </div>
                          <div className="dashboard-card-label">{label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="dashboard-section">
                  <h3 className="dashboard-section-title">Active models</h3>
                  <div className="dashboard-model-list">
                    {[['LLM', dashboardData.models.llm], ['Embeddings', dashboardData.models.embed], ['Vision', dashboardData.models.vision]].map(([label, value]) => (
                      <div key={label} className="dashboard-model-row">
                        <span className="dashboard-model-label">{label}</span>
                        <code className="dashboard-model-value">{value}</code>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="dashboard-section">
                  <h3 className="dashboard-section-title">Token usage (this server session)</h3>
                  <div className="dashboard-cards" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                    {[
                      { label: 'Prompt tokens',     value: dashboardData.tokens.prompt.toLocaleString() },
                      { label: 'Completion tokens', value: dashboardData.tokens.completion.toLocaleString() },
                      { label: 'Total tokens',      value: dashboardData.tokens.total.toLocaleString() },
                    ].map(({ label, value }) => (
                      <div key={label} className="dashboard-card">
                        <div className="dashboard-card-value" style={{ fontSize: '20px' }}>{value}</div>
                        <div className="dashboard-card-label">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {dashboardData.tokens.total > 0 && (
                  <div className="dashboard-section">
                    <h3 className="dashboard-section-title">Estimated cost on paid models</h3>
                    <div className="dashboard-doc-list">
                      {[
                        { model: 'GPT-4o',           input: 2.50,  output: 10.00 },
                        { model: 'GPT-4o mini',      input: 0.15,  output: 0.60  },
                        { model: 'Claude Sonnet 4',  input: 3.00,  output: 15.00 },
                        { model: 'Claude Haiku 4',   input: 0.80,  output: 4.00  },
                        { model: 'Gemini 1.5 Pro',   input: 1.25,  output: 5.00  },
                        { model: 'Gemini 1.5 Flash', input: 0.075, output: 0.30  },
                      ].map(({ model, input, output }) => {
                        const cost = (dashboardData.tokens.prompt / 1e6) * input + (dashboardData.tokens.completion / 1e6) * output
                        return (
                          <div key={model} className="dashboard-doc-row">
                            <span className="dashboard-doc-name">{model}</span>
                            <span className="dashboard-doc-chunks">${cost < 0.001 ? '<$0.001' : cost.toFixed(4)}</span>
                          </div>
                        )
                      })}
                    </div>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      Prices per 1M tokens. Resets on server restart.
                    </p>
                  </div>
                )}

                {Object.keys(dashboardData.documents.file_chunks).length > 0 && (
                  <div className="dashboard-section">
                    <h3 className="dashboard-section-title">Documents</h3>
                    <div className="dashboard-doc-list">
                      {Object.entries(dashboardData.documents.file_chunks).map(([name, chunks]) => (
                        <div key={name} className="dashboard-doc-row">
                          <span className="dashboard-doc-name">{name}</span>
                          <span className="dashboard-doc-chunks">{chunks} chunks</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
