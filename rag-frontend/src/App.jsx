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

// ── Cost models ───────────────────────────────────────────────────────────
const COST_MODELS = [
  { name: 'GPT-4o',           input: 2.50,  output: 10.00 },
  { name: 'GPT-4o mini',      input: 0.15,  output: 0.60  },
  { name: 'Claude Sonnet 4',  input: 3.00,  output: 15.00 },
  { name: 'Claude Haiku 4',   input: 0.80,  output: 4.00  },
  { name: 'Gemini 1.5 Pro',   input: 1.25,  output: 5.00  },
  { name: 'Gemini 1.5 Flash', input: 0.075, output: 0.30  },
]

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

// ── Auth ───────────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [view, setView]     = useState('login')   // 'login' | 'register'
  const [email, setEmail]   = useState('')
  const [password, setPassword] = useState('')
  const [firstname, setFirstname]   = useState('')
  const [lastname, setLastname] = useState('')
  const [error, setError]   = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API}/auth/${view}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(view === 'register' ? { email, password, firstname, lastname } : { email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.detail || 'Error'); return }
      localStorage.setItem('rag_token', data.access_token)
      localStorage.setItem('rag_user', JSON.stringify(data.user))
      onAuth(data.access_token, data.user)
    } catch { setError('Cannot reach server') }
    finally { setLoading(false) }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">RAG Assistant</h1>
        <div className="auth-tabs">
          <button className={`auth-tab ${view === 'login' ? 'active' : ''}`} onClick={() => { setView('login'); setError('') }}>Sign in</button>
          <button className={`auth-tab ${view === 'register' ? 'active' : ''}`} onClick={() => { setView('register'); setError('') }}>Register</button>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <input className="auth-input" type="email" placeholder="Email" value={email}
            onChange={e => setEmail(e.target.value)} required />
          <input className="auth-input" type="password" placeholder="Password (min 6 chars)" value={password}
            onChange={e => setPassword(e.target.value)} required />
          {view === 'register' && (
            <>
              <input className="auth-input" type="text" placeholder="First Name" value={firstname}
                onChange={e => setFirstname(e.target.value)} required />
              <input className="auth-input" type="text" placeholder="Last Name" value={lastname}
                onChange={e => setLastname(e.target.value)} required />
            </>
          )}
          {error && <p className="auth-error">{error}</p>}
          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? 'Please wait…' : view === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p className="auth-hint">
          {view === 'login' ? 'First account created becomes admin.' : 'Already have an account?'}{' '}
          <button className="auth-link" onClick={() => { setView(view === 'login' ? 'register' : 'login'); setError('') }}>
            {view === 'login' ? 'Register' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  )
}

// ── Main App (authenticated) ────────────────────────────────────────────────
function MainApp({ authFetch, currentUser, onLogout }) {
  // Sessions persisted in localStorage
  const sessionsKey    = `rag-sessions-${currentUser.id}`
  const activeKey      = `rag-active-session-${currentUser.id}`

  const [sessions, setSessions] = useState(() => {
    try {
      const saved = localStorage.getItem(sessionsKey)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch {}
    return [createNewSession()]
  })

  const [activeSessionId, setActiveSessionId] = useState(() => {
    try { return localStorage.getItem(activeKey) } catch { return null }
  })

  // Global file registry: filename → { status, size }
  // Shared across sessions so we never re-index the same file twice
  const [globalFiles, setGlobalFiles] = useState({})

  // UI state
  const [question, setQuestion]       = useState('')
  const [isLoading, setIsLoading]     = useState(false)
  const [isDragOver, setIsDragOver]   = useState(false)
  const [showPromptNav, setShowPromptNav] = useState(false)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const [showDashboard, setShowDashboard] = useState(false)
  const [dashboardData, setDashboardData] = useState(null)
  const [evalData, setEvalData]           = useState(null)
  const [evalLoading, setEvalLoading]     = useState(false)
  const [evalSelectedQ, setEvalSelectedQ] = useState(null)
  const [urlInput, setUrlInput]           = useState('')
  const [urlLoading, setUrlLoading]       = useState(false)
  const [urlError, setUrlError]           = useState('')
  const [darkMode, setDarkMode]           = useState(() => localStorage.getItem('rag-theme') === 'dark')
  const [sessionSearch, setSessionSearch] = useState('')
  const [selectedCostModel, setSelectedCostModel] = useState('GPT-4o')
  const [tokenStats, setTokenStats]       = useState(null)
  const [previewFile, setPreviewFile]     = useState(null)  // filename string or null
  const [previewBlobUrl, setPreviewBlobUrl] = useState(null)
  const [previewText, setPreviewText]     = useState(null)

  // Refs
  const fileInputRef        = useRef(null)
  const chatEndRef          = useRef(null)
  const chatScrollRef       = useRef(null)
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
    status:   globalFiles[name]?.status   || 'ready',
    size:     globalFiles[name]?.size     || 0,
    progress: globalFiles[name]?.progress || null,
  }))
  const anyIndexing = sessionFiles.some(f => f.status === 'indexing' || f.status === 'uploading')

  // Keep historyRef in sync (fixes stale-closure issue in handleSubmit)
  useEffect(() => { historyRef.current = history }, [history])

  // Dark mode
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
    localStorage.setItem('rag-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  // Persist sessions
  useEffect(() => { localStorage.setItem(sessionsKey, JSON.stringify(sessions)) }, [sessions])
  useEffect(() => {
    if (activeSession?.id) localStorage.setItem(activeKey, activeSession.id)
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

  // ── Show/hide scroll-to-bottom arrow based on scroll position ────────
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollDown(distFromBottom > 120)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // ── Load file preview when previewFile changes ───────────────────────
  useEffect(() => {
    if (!previewFile) {
      if (previewBlobUrl) { URL.revokeObjectURL(previewBlobUrl); setPreviewBlobUrl(null) }
      setPreviewText(null)
      return
    }
    const ext = previewFile.split('.').pop().toLowerCase()
    const isPreviewable = ['pdf','png','jpg','jpeg','gif','bmp','webp'].includes(ext)
    const isPptx        = ext === 'pptx'
    const isTextPreview = ['docx','xlsx','xls','puml','plantuml','uml','txt','md','csv'].includes(ext)

    if (isPreviewable) {
      authFetch(`${API}/files/${encodeURIComponent(previewFile)}`)
        .then(r => r.blob())
        .then(blob => setPreviewBlobUrl(URL.createObjectURL(blob)))
        .catch(() => setPreviewBlobUrl(null))
    } else if (isPptx) {
      authFetch(`${API}/slides-pdf/${encodeURIComponent(previewFile)}`)
        .then(r => {
          if (!r.ok) return r.json().then(d => Promise.reject(d.detail || 'Conversion failed'))
          return r.blob()
        })
        .then(blob => setPreviewBlobUrl(URL.createObjectURL(blob)))
        .catch(err => setPreviewText(typeof err === 'string' ? err : 'Could not convert to PDF'))
    } else if (isTextPreview) {
      authFetch(`${API}/preview/${encodeURIComponent(previewFile)}`)
        .then(r => r.json())
        .then(d => setPreviewText(d.text || ''))
        .catch(() => setPreviewText('[Could not load preview]'))
    }

    return () => {
      setPreviewBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
      setPreviewText(null)
    }
  }, [previewFile, authFetch])

  // ── Load token stats on startup ──────────────────────────────────────
  useEffect(() => {
    authFetch(`${API}/dashboard`).then(r => r.json()).then(d => setTokenStats(d.tokens)).catch(() => {})
  }, [authFetch])

  // ── Load existing indexed docs on startup ────────────────────────────
  useEffect(() => {
    authFetch(`${API}/documents`)
      .then(r => r.json())
      .then(docs => {
        const registry = {}
        docs.forEach(d => { registry[d.name] = { status: d.status || 'ready', size: 0 } })
        setGlobalFiles(registry)
      })
      .catch(() => {})
  }, [authFetch])

  // ── Poll indexing status ──────────────────────────────────────────────
  const pollStatus = useCallback((filename) => {
    if (pollingRef.current[filename]) return
    pollingRef.current[filename] = setInterval(async () => {
      try {
        const res  = await authFetch(`${API}/status/${encodeURIComponent(filename)}`)
        const data = await res.json()
        if (data.status === 'ready' || data.status === 'error') {
          clearInterval(pollingRef.current[filename])
          delete pollingRef.current[filename]
          setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: data.status, progress: null } }))
        } else {
          setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: data.status, progress: data.progress || null } }))
        }
      } catch {
        clearInterval(pollingRef.current[filename])
        delete pollingRef.current[filename]
      }
    }, 2000)
  }, [authFetch])

  useEffect(() => () => Object.values(pollingRef.current).forEach(clearInterval), [])

  // ── Upload ────────────────────────────────────────────────────────────
  const uploadToBackend = useCallback(async (file) => {
    const fd = new FormData()
    fd.append("file", file)
    const res = await authFetch(`${API}/upload`, { method: "POST", body: fd })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    return res.json()
  }, [authFetch])

  const handleFileSelect = useCallback(async (selectedFiles) => {
    const valid = Array.from(selectedFiles).filter(f => {
      const ext = f.name.split('.').pop().toLowerCase()
      return f.type === 'application/pdf' || f.type.startsWith('image/') ||
        f.type === 'text/plain' || ext === 'txt' || ext === 'docx' ||
        f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        ext === 'xlsx' || ext === 'xls' ||
        f.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        f.type === 'application/vnd.ms-excel' ||
        ext === 'puml' || ext === 'plantuml' || ext === 'uml' ||
        ext === 'md' || ext === 'csv' || ext === 'pptx'
    })

    for (const f of valid) {
      // Already indexed globally → verify server still has it before skipping upload
      if (globalFiles[f.name]?.status === 'ready') {
        try {
          const check = await authFetch(`${API}/status/${encodeURIComponent(f.name)}`)
          const serverStatus = await check.json()
          if (serverStatus.status === 'ready') {
            addFileToSession(f.name)
            continue
          }
          // Server doesn't know about it (e.g. backend restarted) — fall through to re-upload
        } catch {
          // Network error — fall through to re-upload
        }
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
  }, [globalFiles, addFileToSession, uploadToBackend, pollStatus, authFetch])

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
        await authFetch(`${API}/documents/${encodeURIComponent(filename)}`, { method: "DELETE" })
        setGlobalFiles(prev => { const n = { ...prev }; delete n[filename]; return n })
      } catch (e) { console.error("Delete failed:", e) }
    }
  }, [activeSession?.id, sessions, authFetch])

  // ── Re-index file ─────────────────────────────────────────────────────
  const handleReindexFile = useCallback(async (filename) => {
    setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: 'indexing' } }))
    try {
      await authFetch(`${API}/reindex/${encodeURIComponent(filename)}`, { method: "POST" })
      pollStatus(filename)
    } catch (e) {
      console.error("Re-index failed:", e)
      setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: 'error' } }))
    }
  }, [authFetch, pollStatus])

  // ── Cancel indexing ───────────────────────────────────────────────────
  const handleCancelIndexing = useCallback(async (filename) => {
    try {
      await authFetch(`${API}/cancel/${encodeURIComponent(filename)}`, { method: "POST" })
      if (pollingRef.current[filename]) { clearInterval(pollingRef.current[filename]); delete pollingRef.current[filename] }
      const sid = activeSession?.id
      setSessions(prev => prev.map(s =>
        s.id === sid ? { ...s, fileNames: s.fileNames.filter(n => n !== filename) } : s
      ))
      setGlobalFiles(prev => { const n = { ...prev }; delete n[filename]; return n })
    } catch (e) { console.error("Cancel failed:", e) }
  }, [activeSession?.id, authFetch])

  // ── URL ingestion ─────────────────────────────────────────────────────
  const handleUrlIngest = useCallback(async (e) => {
    e.preventDefault()
    const url = urlInput.trim()
    if (!url) return
    setUrlError(''); setUrlLoading(true)
    try {
      const res  = await authFetch(`${API}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json()
      if (!res.ok) { setUrlError(data.detail || 'Failed to fetch URL'); return }
      setUrlInput('')
      setGlobalFiles(prev => ({ ...prev, [data.name]: { status: 'indexing', size: 0 } }))
      addFileToSession(data.name)
      pollStatus(data.name)
    } catch { setUrlError('Cannot reach server') }
    finally { setUrlLoading(false) }
  }, [urlInput, authFetch, addFileToSession, pollStatus])

  // ── Cancel response ───────────────────────────────────────────────────
  const handleCancel = useCallback((e) => {
    if (e?.preventDefault) e.preventDefault()
    if (scrollTimerRef.current) { clearTimeout(scrollTimerRef.current); scrollTimerRef.current = null }
    const cancelledId = pendingIdRef.current
    pendingIdRef.current = null
    isLoadingRef.current = false
    if (cancelledId) {
      // Keep whatever was generated so far — just mark it stopped
      setSessions(prev => prev.map(s => ({
        ...s,
        history: s.history.map(h =>
          h.id === cancelledId
            ? { ...h, answer: (h.answer ?? '').trim() || null, stopped: true }
            : h
        )
      })))
    }
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

    updateHistory(prev => [...prev, { id: tempId, question: currentQuestion, answer: null, sources: [], citations: [], warning: null, sentAt: new Date().toISOString() }])
    scrollTimerRef.current = setTimeout(scrollToBottom, 100)

    const sid = activeSession?.id
    const isFirstMessage = activeSession?.history.length === 0

    try {
      const res = await authFetch(`${API}/ask`, {
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
                ? { ...entry, answer: (entry.answer ?? '').trim(), sources: data.sources || [], citations: data.citations || [], warning: data.warning || null, mode: data.mode || 'standard' }
                : entry
            ))
            scrollTimerRef.current = setTimeout(scrollToBottom, 100)
            // Refresh token stats for cost estimator
            authFetch(`${API}/dashboard`).then(r => r.json()).then(d => setTokenStats(d.tokens)).catch(() => {})
            // Generate a short title from the first message in the background
            if (isFirstMessage) {
              authFetch(`${API}/title`, {
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
  }, [question, scrollToBottom, updateHistory, sessionFileNames, activeSession, authFetch])

  // ── Dashboard ─────────────────────────────────────────────────────────
  const openDashboard = useCallback(async () => {
    setShowDashboard(true)
    setEvalData(null)
    try { const res = await authFetch(`${API}/dashboard`); setDashboardData(await res.json()) }
    catch { setDashboardData(null) }
  }, [authFetch])

  const runEval = useCallback(async () => {
    setEvalLoading(true)
    setEvalData(null)
    try {
      const res  = await authFetch(`${API}/eval`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Eval failed')
      setEvalData(data)
    } catch (e) {
      setEvalData({ error: e.message })
    } finally {
      setEvalLoading(false)
    }
  }, [authFetch])

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
          <button className="clear-history-btn" onClick={() => setDarkMode(d => !d)} title="Toggle dark mode">
            {darkMode ? '☀' : '☾'}
          </button>
          <button className="clear-history-btn" onClick={openDashboard}>Stats</button>
          {history.filter(e => e.answer !== null).length > 0 && (
            <button className="clear-history-btn" onClick={() => window.print()}>Export PDF</button>
          )}
          <div className="user-badge">
            
            
            <button className="logout-btn" onClick={onLogout} title="Sign out">sign out</button>
            <span className="user-fullname">{currentUser.lastname} {currentUser.firstname}</span>
          </div>
        </div>
      </nav>

      <div className="main-container">
        {/* ── Sessions sidebar (left) ── */}
        <aside className="sidebar-sessions">
          <button className="new-chat-btn" onClick={createSession}>＋ New chat</button>

          <div className="session-search-wrap">
            <input
              className="session-search-input"
              type="text"
              placeholder="Search chats…"
              value={sessionSearch}
              onChange={e => setSessionSearch(e.target.value)}
            />
            {sessionSearch && (
              <button className="session-search-clear" onClick={() => setSessionSearch('')}>✕</button>
            )}
          </div>

          <div className="session-list">
            {(() => {
              const q = sessionSearch.trim().toLowerCase()
              const filtered = q
                ? sessions.filter(s =>
                    s.name.toLowerCase().includes(q) ||
                    s.history.some(e =>
                      e.question?.toLowerCase().includes(q) ||
                      e.answer?.toLowerCase().includes(q)
                    )
                  )
                : sessions
              if (filtered.length === 0) return (
                <p className="session-search-empty">No chats match "{sessionSearch}"</p>
              )
              return filtered.map(s => {
                // Find first matching excerpt to show under the session name
                const q_lc = q
                const match = q_lc ? s.history.find(e =>
                  e.question?.toLowerCase().includes(q_lc) ||
                  e.answer?.toLowerCase().includes(q_lc)
                ) : null
                let excerpt = null
                if (match) {
                  const src = match.question?.toLowerCase().includes(q_lc) ? match.question : match.answer
                  const idx = src.toLowerCase().indexOf(q_lc)
                  const start = Math.max(0, idx - 25)
                  excerpt = (start > 0 ? '…' : '') + src.slice(start, idx + q_lc.length + 40).trim() + '…'
                }
                return (
                  <div
                    key={s.id}
                    className={`session-item ${s.id === activeSession?.id ? 'active' : ''}`}
                    onClick={() => switchSession(s.id)}
                  >
                    <div className="session-info">
                      <div className="session-name" title={s.name}>{s.name}</div>
                      {excerpt
                        ? <div className="session-excerpt">{excerpt}</div>
                        : <div className="session-meta">
                            {s.fileNames.length} file{s.fileNames.length !== 1 ? 's' : ''} &middot;{' '}
                            {s.history.filter(h => h.answer).length} msg{s.history.filter(h => h.answer).length !== 1 ? 's' : ''}
                          </div>
                      }
                    </div>
                    <button
                      className="session-delete"
                      onClick={ev => { ev.stopPropagation(); if (window.confirm('Delete this chat?')) deleteSession(s.id) }}
                      title="Delete session"
                    >✕</button>
                  </div>
                )
              })
            })()}
          </div>
        </aside>

        <main className="chat-area">
          <div className="print-header">
            <div className="print-header-title">RAG Assistant — Chat Export</div>
            <div className="print-header-date">{new Date().toLocaleString()}</div>
          </div>

          <div
            className="chat-messages"
            ref={chatScrollRef}
            onScroll={e => {
              const el = e.currentTarget
              setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 120)
            }}
          >
            {history.length === 0 && !isLoading && (
              <div className="chat-empty">
                <ChatIcon />
                <h3 className="chat-empty-title">Start a conversation</h3>
                <p className="chat-empty-text">Upload documents and ask questions to get answers with source citations.</p>
              </div>
            )}

            {history.map(entry => (
              <div key={entry.id} id={`msg-${entry.id}`} className="conversation-entry">
                <div className="message-wrapper user">
                  <div className="message user">
                    <p className="message-content">{entry.question}</p>
                  </div>
                  {entry.sentAt && (
                    <div className="message-user-meta">
                      <span className="message-timestamp">
                        {new Date(entry.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  )}
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
                        {entry.stopped && (
                          <div className="stopped-indicator">⬛ Stopped</div>
                        )}
                        <button
                          className="copy-btn"
                          onClick={() => navigator.clipboard.writeText(entry.answer)}
                          title="Copy response"
                        >Copy</button>
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
                      {entry.mode === 'comparison' && (
                        <span className="source-pill comparison-badge" title="Per-file balanced retrieval was used">
                          ⇄ Comparing {entry.sources.length} docs
                        </span>
                      )}
                      {(entry.citations?.length > 0 ? entry.citations : entry.sources.map(s => ({ file: s, pages: [] }))).map((c, i) => (
                        <span key={i} className="source-pill">
                          <SourceIcon />
                          {c.file}
                          {c.pages?.length > 0 && (
                            <span className="source-pages">p. {c.pages.join(', ')}</span>
                          )}
                        </span>
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

          {/* ── Scroll-to-bottom arrow ── */}
          {showScrollDown && (
            <button
              className="scroll-down-btn"
              onClick={scrollToBottom}
              title="Scroll to latest"
            >↓</button>
          )}

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
            {tokenStats && tokenStats.total > 0 && (() => {
              const model = COST_MODELS.find(m => m.name === selectedCostModel) || COST_MODELS[0]
              const cost  = (tokenStats.prompt / 1e6) * model.input + (tokenStats.completion / 1e6) * model.output
              const costStr = cost < 0.0001 ? '<$0.0001' : `$${cost.toFixed(4)}`
              return (
                <div className="cost-estimator">
                  <span className="cost-label">Session cost on</span>
                  <select
                    className="cost-model-select"
                    value={selectedCostModel}
                    onChange={e => setSelectedCostModel(e.target.value)}
                  >
                    {COST_MODELS.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                  </select>
                  <span className="cost-value">{costStr}</span>
                  <span className="cost-tokens">· {tokenStats.total.toLocaleString()} tokens</span>
                </div>
              )
            })()}
          </form>
        </main>

        {/* ── Files sidebar (right) ── */}
        <aside className="sidebar-files">
          {/* Prompt navigator */}
          {history.filter(e => e.question).length > 0 && (
            <div className="prompt-nav-sidebar">
              <button
                className="prompt-nav-sidebar-header"
                onClick={() => setShowPromptNav(p => !p)}
              >
                <span className="sidebar-title" style={{ pointerEvents: 'none' }}>Prompts</span>
                <span className="prompt-nav-chevron">{showPromptNav ? '▲' : '▼'}</span>
              </button>
              {showPromptNav && (
                <div className="prompt-nav-sidebar-list">
                  {history.filter(e => e.question).map((entry, idx) => (
                    <button
                      key={entry.id}
                      className="prompt-nav-item"
                      onClick={() => {
                        document.getElementById(`msg-${entry.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}
                    >
                      <span className="prompt-nav-index">{idx + 1}</span>
                      <span className="prompt-nav-text">{entry.question.length > 55 ? entry.question.slice(0, 55) + '…' : entry.question}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

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
            <p className="upload-hint">PDF, Word, Excel, PowerPoint, UML, TXT or images</p>
            <input
              ref={fileInputRef} type="file" accept=".pdf,.txt,.docx,.xlsx,.xls,.pptx,.puml,.plantuml,.uml,.md,.csv,image/*" multiple
              style={{ display: 'none' }}
              onChange={ev => { handleFileSelect(ev.target.files); ev.target.value = '' }}
            />
          </div>

          <form className="url-ingest-form" onSubmit={handleUrlIngest}>
            <input
              className="url-ingest-input"
              type="url"
              placeholder="Paste a URL to index…"
              value={urlInput}
              onChange={e => { setUrlInput(e.target.value); setUrlError('') }}
              disabled={urlLoading}
            />
            <button className="url-ingest-btn" type="submit" disabled={urlLoading || !urlInput.trim()}>
              {urlLoading ? '…' : '↓'}
            </button>
          </form>
          {urlError && <p className="url-ingest-error">{urlError}</p>}

          {sessionFiles.length > 0 && (
            <div className="file-list">
              {sessionFiles.map(file => {
                const badge = getStatusBadge(file.status)
                return (
                  <div
                    key={file.name}
                    className={`file-item ${file.status === 'ready' ? 'file-item--clickable' : ''}`}
                    onClick={() => { if (file.status === 'ready') setPreviewFile(file.name) }}
                  >
                    <FileIcon />
                    <div className="file-info">
                      <div className="file-name">{file.name}</div>
                      <div className="file-size" style={{ color: badge?.color }}>
                        {badge ? badge.label : formatFileSize(file.size)}
                      </div>
                    </div>
                    {file.status === 'ready' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div
                          onClick={ev => { ev.stopPropagation(); handleReindexFile(file.name) }}
                          style={{ cursor: 'pointer', opacity: 0.5, fontSize: '14px', lineHeight: 1, padding: '2px 4px' }}
                          title="Re-index with latest extractor"
                        >↺</div>
                        <div onClick={ev => { ev.stopPropagation(); handleRemoveFile(file.name) }} style={{ cursor: 'pointer' }}>
                          <RemoveIcon />
                        </div>
                      </div>
                    )}
                    {(file.status === 'indexing' || file.status === 'uploading') && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '80px' }}>
                        {file.progress && file.progress.total > 0 ? (
                          <>
                            <div className="progress-bar-wrap">
                              <div className="progress-bar" style={{
                                width: `${Math.round((file.progress.current / file.progress.total) * 100)}%`
                              }} />
                            </div>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'right' }}>
                              Page {file.progress.current}/{file.progress.total}
                            </span>
                          </>
                        ) : (
                          <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                            {[0, 1, 2].map(i => (
                              <div key={i} style={{
                                width: '4px', height: '4px', borderRadius: '50%',
                                background: 'var(--text-muted)',
                                animation: `loading-pulse 1.2s infinite ${i * 0.2}s`
                              }} />
                            ))}
                          </div>
                        )}
                        {file.status === 'indexing' && (
                          <span onClick={() => handleCancelIndexing(file.name)} style={{
                            fontSize: '11px', color: '#854F0B', cursor: 'pointer', textDecoration: 'underline', textAlign: 'right'
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

      {/* ── File preview modal ── */}
      {previewFile && (() => {
        const ext     = previewFile.split('.').pop().toLowerCase()
        const fileUrl = `${API}/files/${encodeURIComponent(previewFile)}`
        const isImage    = ['png','jpg','jpeg','gif','bmp','webp'].includes(ext)
        const isPdf      = ext === 'pdf'
        const isPptx     = ext === 'pptx'
        const hasText    = previewText !== null
        return (
          <div className="preview-overlay" onClick={() => { setPreviewFile(null) }}>
            <div className="preview-modal" onClick={e => e.stopPropagation()}>
              <div className="preview-header">
                <span className="preview-filename">{previewFile}</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {previewBlobUrl && (
                    <button className="preview-open-btn" onClick={() => window.open(previewBlobUrl, '_blank')}>Open in tab ↗</button>
                  )}
                  <button className="dashboard-close" onClick={() => setPreviewFile(null)}>✕</button>
                </div>
              </div>
              <div className="preview-body">
                {(isPdf || isPptx) && (
                  previewBlobUrl
                    ? <iframe src={previewBlobUrl} title={previewFile} className="preview-iframe" />
                    : hasText
                      ? <pre className="preview-text">{previewText}</pre>  // LibreOffice error message
                      : <div className="preview-loading">Converting to PDF…</div>
                )}
                {isImage && (
                  previewBlobUrl
                    ? <img src={previewBlobUrl} alt={previewFile} className="preview-image" />
                    : <div className="preview-loading">Loading…</div>
                )}
                {!isPdf && !isImage && hasText && (
                  <pre className="preview-text">{previewText}</pre>
                )}
                {!isPdf && !isImage && !hasText && (
                  <div className="preview-loading">Loading…</div>
                )}
              </div>
            </div>
          </div>
        )
      })()}

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

                <div className="dashboard-section">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h3 className="dashboard-section-title">Retrieval evaluation</h3>
                    <button className="clear-history-btn" onClick={runEval} disabled={evalLoading}
                      style={{ fontSize: '12px', padding: '4px 12px' }}>
                      {evalLoading ? 'Running…' : 'Run eval'}
                    </button>
                  </div>

                  {!evalData && !evalLoading && (
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      Measures Hit Rate, Precision, MRR and Recall against <code>eval_dataset.json</code>.
                      Make sure the dataset files are indexed before running.
                    </p>
                  )}

                  {evalLoading && (
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      Running retrieval for each question — this may take 30–60 s…
                    </p>
                  )}

                  {evalData?.error && (
                    <p style={{ fontSize: '12px', color: '#e53e3e' }}>{evalData.error}</p>
                  )}

                  {evalData && !evalData.error && (
                    <>
                      {/* Configuration comparison table */}
                      {evalData.configurations && (
                        <div className="eval-config-table">
                          <div className="eval-config-row eval-config-header">
                            <span className="eval-config-name">Configuration</span>
                            <span className="eval-config-metric">Hit@{evalData.top_k}</span>
                            <span className="eval-config-metric">MRR</span>
                          </div>
                          {evalData.configurations.map(cfg => (
                            <div key={cfg.name} className={`eval-config-row${cfg.name === 'Hybrid + Reranker' ? ' eval-config-best' : ''}`}>
                              <span className="eval-config-name">{cfg.name}</span>
                              <span className="eval-config-metric">{(cfg.hit_rate * 100).toFixed(0)}%</span>
                              <span className="eval-config-metric">{cfg.mrr.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Per-question table — click a row to see retrieved chunks */}
                      <div className="dashboard-doc-list" style={{ marginTop: '8px' }}>
                        <div className="dashboard-doc-row" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-muted)' }}>
                          <span style={{ flex: 2 }}>Question ID</span>
                          <span style={{ width: 28, textAlign: 'center' }}>Hit</span>
                          <span style={{ width: 40, textAlign: 'right' }}>P@K</span>
                          <span style={{ width: 40, textAlign: 'right' }}>MRR</span>
                        </div>
                        {evalData.per_question.map(r => (
                          <div key={r.id}>
                            <div
                              className="dashboard-doc-row eval-q-row"
                              onClick={() => setEvalSelectedQ(evalSelectedQ === r.id ? null : r.id)}
                              title="Click to see retrieved chunks"
                            >
                              <span className="dashboard-doc-name" style={{ flex: 2 }}>{r.id}</span>
                              <span style={{ width: 28, textAlign: 'center', color: r.hit ? '#276030' : '#9B2020', fontWeight: 600 }}>
                                {r.hit ? '✓' : '✗'}
                              </span>
                              <span className="dashboard-doc-chunks" style={{ width: 40 }}>{r.precision.toFixed(2)}</span>
                              <span className="dashboard-doc-chunks" style={{ width: 40 }}>{r.mrr.toFixed(2)}</span>
                            </div>
                            {evalSelectedQ === r.id && (
                              <div className="eval-detail-card">
                                <div className="eval-detail-label">Question</div>
                                <div className="eval-detail-value">{r.question}</div>
                                <div className="eval-detail-label" style={{ marginTop: '8px' }}>Expected source</div>
                                <div className="eval-detail-value">{(r.source_files || []).join(', ') || '—'}</div>
                                <div className="eval-detail-label" style={{ marginTop: '8px' }}>Retrieved</div>
                                {(r.retrieved || []).map((chunk, i) => (
                                  <div key={i} className={`eval-chunk-row${chunk.hit ? ' eval-chunk-hit' : ' eval-chunk-miss'}`}>
                                    <span className="eval-chunk-icon">{chunk.hit ? '✓' : '✗'}</span>
                                    <span>{chunk.file}{chunk.page && chunk.page !== '?' ? ` (page ${chunk.page})` : ''}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {evalData.n_questions} questions · click a row to inspect retrieved chunks
                      </p>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Root App — handles auth state, renders AuthScreen or MainApp ────────────
function App() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('rag_token'))
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rag_user')) } catch { return null }
  })

  const handleAuth = (token, user) => { setAuthToken(token); setCurrentUser(user) }
  const handleLogout = useCallback(() => {
    localStorage.removeItem('rag_token'); localStorage.removeItem('rag_user')
    setAuthToken(null); setCurrentUser(null)
  }, [])

  const authFetch = useCallback((url, options = {}) => {
    return fetch(url, {
      ...options,
      headers: { ...options.headers, ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) }
    }).then(res => {
      if (res.status === 401) handleLogout()
      return res
    })
  }, [authToken, handleLogout])

  if (!authToken || !currentUser) return <AuthScreen onAuth={handleAuth} />
  return <MainApp authFetch={authFetch} currentUser={currentUser} onLogout={handleLogout} />
}

export default App
