import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Plus, Search, Trash2, Upload, FileText, X, Send, Square,
  Sun, Moon, BarChart2, LogOut, RefreshCw, Link2, ChevronDown,
  ChevronUp, MessageSquare, Cpu, Cloud, AlertTriangle, Copy,
  Loader2, ExternalLink, RotateCcw, BookOpen, Paperclip, Menu
} from 'lucide-react'
import './App.css'
import { AreaChart, Area, XAxis, Tooltip as RechartTooltip, ResponsiveContainer } from 'recharts'
import { BackgroundBeams }    from '@/components/ui/background-beams'
import { Spotlight }          from '@/components/ui/spotlight'
import { TextGenerateEffect } from '@/components/ui/text-generate-effect'
import { HoverEffect }        from '@/components/ui/card-hover-effect'
import { ShimmerButton }      from '@/components/ui/shimmer-button'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const COST_MODELS = [
  { name: 'GPT-4o',           input: 2.50,  output: 10.00 },
  { name: 'GPT-4o mini',      input: 0.15,  output: 0.60  },
  { name: 'Claude Sonnet 4',  input: 3.00,  output: 15.00 },
  { name: 'Claude Haiku 4',   input: 0.80,  output: 4.00  },
  { name: 'Gemini 1.5 Pro',   input: 1.25,  output: 5.00  },
  { name: 'Gemini 1.5 Flash', input: 0.075, output: 0.30  },
]

const CLOUD_MODELS = [
  { key: 'llama-3.3-70b-versatile',                           label: '3.3 70B',   limit: 100_000 },
  { key: 'llama-3.1-8b-instant',                              label: '3.1 8B',    limit: 500_000 },
  { key: 'meta-llama/llama-4-scout-17b-16e-instruct',         label: 'Scout 17B', limit: 100_000 },
]

function evalBadgeClass(score) {
  if (score >= 0.8) return 'text-emerald-700 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950/40'
  if (score >= 0.5) return 'text-amber-700 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950/40'
  return 'text-red-700 border-red-200 bg-red-50 dark:text-red-400 dark:border-red-800 dark:bg-red-950/40'
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

// ─── Auth Screen ────────────────────────────────────────────────────────────

function AuthScreen({ onAuth }) {
  const [view, setView]         = useState('login')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [firstname, setFirstname] = useState('')
  const [lastname, setLastname]   = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API}/auth/${view}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(view === 'register'
          ? { email, password, firstname, lastname }
          : { email, password }),
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
    <div className="min-h-screen bg-background flex items-center justify-center p-4 relative overflow-hidden">
      <BackgroundBeams className="opacity-40" />
      <Card className="w-full max-w-sm shadow-lg relative z-10">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto mb-3 w-11 h-11 bg-primary rounded-xl flex items-center justify-center shadow-sm">
            <MessageSquare className="w-5 h-5 text-primary-foreground" />
          </div>
          <CardTitle className="text-xl">RAG Assistant</CardTitle>
          <CardDescription>
            {view === 'login' ? 'Sign in to your account' : 'Create a new account'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex rounded-lg bg-muted p-1 mb-5 gap-1">
            {['login', 'register'].map(v => (
              <button
                key={v}
                onClick={() => { setView(v); setError('') }}
                className={cn(
                  'flex-1 py-1.5 text-sm rounded-md transition-all font-medium',
                  view === v
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {v === 'login' ? 'Sign in' : 'Register'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3">
            <Input type="email" placeholder="Email" value={email}
              onChange={e => setEmail(e.target.value)} required autoComplete="email" />
            <Input type="password" placeholder="Password (min 6 chars)" value={password}
              onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
            {view === 'register' && (
              <>
                <Input type="text" placeholder="First Name" value={firstname}
                  onChange={e => setFirstname(e.target.value)} required />
                <Input type="text" placeholder="Last Name" value={lastname}
                  onChange={e => setLastname(e.target.value)} required />
              </>
            )}
            {error && (
              <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 px-3 py-2 rounded-md">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Please wait…</>
                : view === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground mt-4">
            {view === 'login' ? 'First account becomes admin. ' : 'Already have an account? '}
            <button
              onClick={() => { setView(view === 'login' ? 'register' : 'login'); setError('') }}
              className="text-primary hover:underline font-medium"
            >
              {view === 'login' ? 'Register' : 'Sign in'}
            </button>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

function MainApp({ authFetch, currentUser, onLogout }) {
  const sessionsKey = `rag-sessions-${currentUser.id}`
  const activeKey   = `rag-active-session-${currentUser.id}`

  // ── State ─────────────────────────────────────────────────────────────────
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
  const [globalFiles, setGlobalFiles]         = useState({})
  const [question, setQuestion]               = useState('')
  const [isLoading, setIsLoading]             = useState(false)
  const [isDragOver, setIsDragOver]           = useState(false)
  const [showPromptNav, setShowPromptNav]     = useState(false)
  const [showScrollDown, setShowScrollDown]   = useState(false)
  const [showDashboard, setShowDashboard]     = useState(false)
  const [dashboardData, setDashboardData]     = useState(null)
  const [evalData, setEvalData]               = useState(null)
  const [evalLoading, setEvalLoading]         = useState(false)
  const [chunkView, setChunkView]             = useState({})
  const [summaryView, setSummaryView]         = useState({})
  const [evalSelectedQ, setEvalSelectedQ]     = useState(null)
  const [qualityData, setQualityData]         = useState(null)
  const [qualityLoading, setQualityLoading]   = useState(false)
  const [qualitySelectedQ, setQualitySelectedQ] = useState(null)
  const [urlInput, setUrlInput]               = useState('')
  const [urlLoading, setUrlLoading]           = useState(false)
  const [urlError, setUrlError]               = useState('')
  const [darkMode, setDarkMode]               = useState(() => {
    const saved = localStorage.getItem('rag-theme')
    if (saved) return saved === 'dark'
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  })
  const [sessionSearch, setSessionSearch]     = useState('')
  const [selectedCostModel, setSelectedCostModel] = useState('GPT-4o')
  const [tokenStats, setTokenStats]           = useState(null)
  const [previewFile, setPreviewFile]         = useState(null)
  const [previewBlobUrl, setPreviewBlobUrl]   = useState(null)
  const [previewText, setPreviewText]         = useState(null)
  const [provider, setProvider]               = useState(() => localStorage.getItem('rag-provider') || 'local')
  const [groqTokens, setGroqTokens]           = useState(null)
  const [showLeftSidebar, setShowLeftSidebar]   = useState(false)
  const [showRightSidebar, setShowRightSidebar] = useState(false)
  const [cloudModel, setCloudModel] = useState(() => localStorage.getItem('rag-cloud-model') || 'llama-3.3-70b-versatile')
  const [rightSidebarTab, setRightSidebarTab] = useState('files')
  const [usagePeriod, setUsagePeriod] = useState('daily')
  const [hypothesisOpenId, setHypothesisOpenId] = useState(null)
  const [showChatUrl, setShowChatUrl] = useState(false)
  const [chatUrlInput, setChatUrlInput] = useState('')
  const [showAllModels, setShowAllModels] = useState(false)

  // ── Refs ──────────────────────────────────────────────────────────────────
  const fileInputRef       = useRef(null)
  const chatEndRef         = useRef(null)
  const chatScrollRef      = useRef(null)
  const abortControllerRef = useRef(null)
  const scrollTimerRef     = useRef(null)
  const pendingIdRef       = useRef(null)
  const isLoadingRef       = useRef(false)
  const currentQuestionRef = useRef('')
  const pollingRef         = useRef({})
  const historyRef         = useRef([])
  const historyIndexRef    = useRef(-1)
  const draftQuestionRef   = useRef('')

  // ── Derived ───────────────────────────────────────────────────────────────
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

  const evalEntries    = sessions.flatMap(s => s.history.filter(e => e.eval))
  const avgFaithfulness = evalEntries.length
    ? evalEntries.reduce((a, e) => a + e.eval.faithfulness, 0) / evalEntries.length : null
  const avgRelevance   = evalEntries.length
    ? evalEntries.reduce((a, e) => a + e.eval.answer_relevance, 0) / evalEntries.length : null
  const totalQuestions = sessions.reduce((acc, s) => acc + s.history.filter(e => e.answer !== null).length, 0)

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => { historyRef.current = history }, [history])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('rag-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => { localStorage.setItem('rag-cloud-model', cloudModel) }, [cloudModel])

  useEffect(() => {
    if (!showDashboard) return
    authFetch(`${API}/dashboard`).then(r => r.json()).then(d => {
      setDashboardData(d); setTokenStats(d.tokens); if (d.groq_tokens) setGroqTokens(d.groq_tokens)
    }).catch(() => {})
  }, [provider, cloudModel, showDashboard])

  useEffect(() => {
    localStorage.setItem('rag-provider', provider)
    const token = localStorage.getItem('rag_token')
    if (!token) return
    fetch(`${API}/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider }),
    }).catch(() => {})
  }, [provider])

  useEffect(() => { localStorage.setItem(sessionsKey, JSON.stringify(sessions)) }, [sessions])
  useEffect(() => {
    if (activeSession?.id) localStorage.setItem(activeKey, activeSession.id)
  }, [activeSession?.id])

  useEffect(() => {
    authFetch(`${API}/dashboard`).then(r => r.json()).then(d => {
      setTokenStats(d.tokens)
      if (d.groq_tokens) setGroqTokens(d.groq_tokens)
    }).catch(() => {})
  }, [authFetch])

  useEffect(() => {
    authFetch(`${API}/documents`)
      .then(r => r.json())
      .then(docs => {
        const registry = {}
        docs.forEach(d => { registry[d.name] = { status: d.status || 'ready', size: 0 } })
        setGlobalFiles(registry)
      }).catch(() => {})
  }, [authFetch])

  useEffect(() => {
    if (!previewFile) {
      if (previewBlobUrl) { URL.revokeObjectURL(previewBlobUrl); setPreviewBlobUrl(null) }
      setPreviewText(null)
      return
    }
    const ext = previewFile.split('.').pop().toLowerCase()
    const isPreviewable = ['pdf','png','jpg','jpeg','gif','bmp','webp'].includes(ext)
    const isPptx        = ext === 'pptx'
    const isDocPreview  = ['docx','doc','xlsx','xls'].includes(ext)
    const isTextPreview = ['puml','plantuml','uml','txt','md','csv'].includes(ext)

    if (isPreviewable) {
      authFetch(`${API}/files/${encodeURIComponent(previewFile)}`)
        .then(r => r.blob()).then(blob => setPreviewBlobUrl(URL.createObjectURL(blob)))
        .catch(() => setPreviewBlobUrl(null))
    } else if (isPptx) {
      authFetch(`${API}/slides-pdf/${encodeURIComponent(previewFile)}`)
        .then(r => { if (!r.ok) return r.json().then(d => Promise.reject(d.detail || 'Conversion failed')); return r.blob() })
        .then(blob => setPreviewBlobUrl(URL.createObjectURL(blob)))
        .catch(err => setPreviewText(typeof err === 'string' ? err : 'Could not convert to PDF'))
    } else if (isDocPreview) {
      authFetch(`${API}/doc-pdf/${encodeURIComponent(previewFile)}`)
        .then(r => { if (!r.ok) return r.json().then(d => Promise.reject(d.detail || 'Conversion failed')); return r.blob() })
        .then(blob => setPreviewBlobUrl(URL.createObjectURL(blob)))
        .catch(err => setPreviewText(typeof err === 'string' ? err : 'Could not convert to PDF'))
    } else if (isTextPreview) {
      authFetch(`${API}/preview/${encodeURIComponent(previewFile)}`)
        .then(r => r.json()).then(d => setPreviewText(d.text || ''))
        .catch(() => setPreviewText('[Could not load preview]'))
    }
    return () => {
      setPreviewBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
      setPreviewText(null)
    }
  }, [previewFile, authFetch])

  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const onScroll = () => setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 120)
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => () => Object.values(pollingRef.current).forEach(clearInterval), [])

  useEffect(() => {
    if (!tokenStats?.total || !currentUser?.email) return
    const today = new Date().toISOString().slice(0, 10)
    const key = `rag-usage-${currentUser.email}`
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}')
      saved[today] = { prompt: tokenStats.prompt || 0, completion: tokenStats.completion || 0, total: tokenStats.total }
      localStorage.setItem(key, JSON.stringify(saved))
    } catch {}
  }, [tokenStats, currentUser?.email])

  // ── Callbacks ─────────────────────────────────────────────────────────────
  const updateHistory = useCallback((updater) => {
    const sid = activeSession?.id
    setSessions(prev => prev.map(s =>
      s.id === sid
        ? { ...s, history: typeof updater === 'function' ? updater(s.history) : updater }
        : s
    ))
  }, [activeSession?.id])

  const createSession = useCallback(() => {
    if (activeSession && activeSession.history.length === 0 && activeSession.fileNames.length === 0) {
      setActiveSessionId(activeSession.id); return
    }
    const s = createNewSession()
    setSessions(prev => [s, ...prev])
    setActiveSessionId(s.id)
    setQuestion('')
  }, [activeSession])

  const switchSession = useCallback((id) => {
    if (isLoadingRef.current) {
      const cancelledId = pendingIdRef.current
      pendingIdRef.current = null; isLoadingRef.current = false; setIsLoading(false)
      if (abortControllerRef.current) { abortControllerRef.current.abort(); abortControllerRef.current = null }
      if (cancelledId) setSessions(prev => prev.map(s => ({ ...s, history: s.history.filter(e => e.id !== cancelledId) })))
    }
    setActiveSessionId(id); setQuestion('')
    historyIndexRef.current = -1; draftQuestionRef.current = ''
  }, [])

  const deleteSession = useCallback((id) => {
    setSessions(prev => {
      const target    = prev.find(s => s.id === id)
      const remaining = prev.filter(s => s.id !== id)
      if (target?.fileNames?.length) {
        const otherFiles = new Set(remaining.flatMap(s => s.fileNames))
        target.fileNames.forEach(filename => {
          if (!otherFiles.has(filename)) {
            authFetch(`${API}/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' })
              .then(() => setGlobalFiles(prev => { const n = { ...prev }; delete n[filename]; return n }))
              .catch(e => console.error('Delete file on session removal failed:', e))
          }
        })
      }
      if (remaining.length === 0) {
        const fresh = createNewSession(); setActiveSessionId(fresh.id); return [fresh]
      }
      if (activeSession?.id === id) setActiveSessionId(remaining[0].id)
      return remaining
    })
  }, [activeSession?.id, authFetch])

  const addFileToSession = useCallback((filename) => {
    const sid = activeSession?.id
    setSessions(prev => prev.map(s => {
      if (s.id !== sid || s.fileNames.includes(filename)) return s
      const shouldRename  = s.name === 'New chat' && s.history.length === 0
      const nameFromFile  = filename.replace(/\.[^/.]+$/, '')
      const name = shouldRename ? (nameFromFile.length > 35 ? nameFromFile.slice(0, 35) + '…' : nameFromFile) : s.name
      return { ...s, name, fileNames: [...s.fileNames, filename] }
    }))
  }, [activeSession?.id])

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

  const pollStatus = useCallback((filename) => {
    if (pollingRef.current[filename]) return
    pollingRef.current[filename] = setInterval(async () => {
      try {
        const res  = await authFetch(`${API}/status/${encodeURIComponent(filename)}`)
        const data = await res.json()
        if (data.status === 'ready' || data.status === 'error') {
          clearInterval(pollingRef.current[filename]); delete pollingRef.current[filename]
          setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: data.status, progress: null } }))
        } else {
          setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: data.status, progress: data.progress || null } }))
        }
      } catch { clearInterval(pollingRef.current[filename]); delete pollingRef.current[filename] }
    }, 2000)
  }, [authFetch])

  const uploadToBackend = useCallback(async (file) => {
    const fd = new FormData(); fd.append('file', file)
    const res = await authFetch(`${API}/upload`, { method: 'POST', body: fd })
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
      if (globalFiles[f.name]?.status === 'ready') {
        try {
          const check = await authFetch(`${API}/status/${encodeURIComponent(f.name)}`)
          const serverStatus = await check.json()
          if (serverStatus.status === 'ready') { addFileToSession(f.name); continue }
        } catch {}
      }
      if (globalFiles[f.name]?.status === 'indexing') { addFileToSession(f.name); pollStatus(f.name); continue }
      setGlobalFiles(prev => ({ ...prev, [f.name]: { status: 'uploading', size: f.size } }))
      addFileToSession(f.name)
      try {
        const result = await uploadToBackend(f)
        setGlobalFiles(prev => ({ ...prev, [f.name]: { ...prev[f.name], status: result.status } }))
        if (result.status === 'indexing') pollStatus(f.name)
      } catch { setGlobalFiles(prev => ({ ...prev, [f.name]: { ...prev[f.name], status: 'error' } })) }
    }
  }, [globalFiles, addFileToSession, uploadToBackend, pollStatus, authFetch])

  const handleRemoveFile = useCallback(async (filename) => {
    const sid = activeSession?.id
    setSessions(prev => prev.map(s => s.id === sid ? { ...s, fileNames: s.fileNames.filter(n => n !== filename) } : s))
    const otherUses = sessions.some(s => s.id !== sid && s.fileNames.includes(filename))
    if (!otherUses) {
      try {
        await authFetch(`${API}/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' })
        setGlobalFiles(prev => { const n = { ...prev }; delete n[filename]; return n })
      } catch (e) { console.error('Delete failed:', e) }
    }
  }, [activeSession?.id, sessions, authFetch])

  const handleReindexFile = useCallback(async (filename) => {
    setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: 'indexing' } }))
    try {
      await authFetch(`${API}/reindex/${encodeURIComponent(filename)}`, { method: 'POST' })
      pollStatus(filename)
    } catch (e) {
      console.error('Re-index failed:', e)
      setGlobalFiles(prev => ({ ...prev, [filename]: { ...prev[filename], status: 'error' } }))
    }
  }, [authFetch, pollStatus])

  const handleCancelIndexing = useCallback(async (filename) => {
    try {
      await authFetch(`${API}/cancel/${encodeURIComponent(filename)}`, { method: 'POST' })
      if (pollingRef.current[filename]) { clearInterval(pollingRef.current[filename]); delete pollingRef.current[filename] }
      const sid = activeSession?.id
      setSessions(prev => prev.map(s => s.id === sid ? { ...s, fileNames: s.fileNames.filter(n => n !== filename) } : s))
      setGlobalFiles(prev => { const n = { ...prev }; delete n[filename]; return n })
    } catch (e) { console.error('Cancel failed:', e) }
  }, [activeSession?.id, authFetch])

  const handleUrlIngest = useCallback(async (e, overrideUrl) => {
    if (e?.preventDefault) e.preventDefault()
    const url = (overrideUrl || urlInput).trim(); if (!url) return
    setUrlError(''); setUrlLoading(true)
    try {
      const res  = await authFetch(`${API}/upload-url`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json()
      if (!res.ok) { setUrlError(data.detail || 'Failed to fetch URL'); return }
      if (!overrideUrl) setUrlInput('')
      setGlobalFiles(prev => ({ ...prev, [data.name]: { status: 'indexing', size: 0 } }))
      addFileToSession(data.name); pollStatus(data.name)
    } catch { setUrlError('Cannot reach server') }
    finally { setUrlLoading(false) }
  }, [urlInput, authFetch, addFileToSession, pollStatus])

  const handleCancel = useCallback((e) => {
    if (e?.preventDefault) e.preventDefault()
    if (scrollTimerRef.current) { clearTimeout(scrollTimerRef.current); scrollTimerRef.current = null }
    const cancelledId = pendingIdRef.current
    pendingIdRef.current = null; isLoadingRef.current = false
    if (cancelledId) {
      setSessions(prev => prev.map(s => ({ ...s, history: s.history.filter(h => h.id !== cancelledId) })))
      setQuestion(currentQuestionRef.current)
    }
    setIsLoading(false)
    if (abortControllerRef.current) { abortControllerRef.current.abort(); abortControllerRef.current = null }
  }, [])

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault()
    if (!question.trim() || isLoadingRef.current) return
    const currentQuestion = question.trim()
    currentQuestionRef.current = currentQuestion
    historyIndexRef.current = -1; draftQuestionRef.current = ''
    isLoadingRef.current = true; setIsLoading(true); setQuestion('')
    abortControllerRef.current = new AbortController()
    const tempId = generateId(); pendingIdRef.current = tempId
    updateHistory(prev => [...prev, { id: tempId, question: currentQuestion, answer: null, sources: [], citations: [], warning: null, sentAt: new Date().toISOString() }])
    scrollTimerRef.current = setTimeout(scrollToBottom, 100)
    const sid = activeSession?.id
    const isFirstMessage = activeSession?.history.length === 0
    try {
      const res = await authFetch(`${API}/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: currentQuestion,
          history: historyRef.current
            .filter(e => e.answer !== null && !e.answer.startsWith('Error:'))
            .map(e => ({ question: e.question, answer: e.answer })),
          files: sessionFileNames, provider,
          groq_model: provider === 'cloud' ? cloudModel : undefined,
        }),
        signal: abortControllerRef.current.signal,
      })
      if (!pendingIdRef.current) return
      if (!res.ok) { const err = await res.json(); throw new Error(err.detail || `Server error: ${res.status}`) }
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      let buffer = ''; let scrolledOnFirst = false
      while (true) {
        if (!pendingIdRef.current) { reader.cancel(); break }
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim(); if (!raw) continue
          let data; try { data = JSON.parse(raw) } catch { continue }
          if (data.type === 'token' && data.content) {
            updateHistory(prev => prev.map(entry => entry.id === tempId ? { ...entry, answer: (entry.answer ?? '') + data.content } : entry))
            if (!scrolledOnFirst) { scrolledOnFirst = true; scrollTimerRef.current = setTimeout(scrollToBottom, 100) }
          } else if (data.type === 'done') {
            updateHistory(prev => prev.map(entry => entry.id === tempId
              ? { ...entry, answer: (entry.answer ?? '').trim(), sources: data.sources || [], citations: data.citations || [], warning: data.warning || null, mode: data.mode || 'standard' }
              : entry))
            scrollTimerRef.current = setTimeout(scrollToBottom, 100)
            authFetch(`${API}/dashboard`).then(r => r.json()).then(d => { setTokenStats(d.tokens); if (d.groq_tokens) setGroqTokens(d.groq_tokens) }).catch(() => {})
            if (isFirstMessage) {
              authFetch(`${API}/title`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: currentQuestion, files: sessionFileNames }) })
                .then(r => r.json()).then(({ title }) => { if (title) setSessions(prev => prev.map(s => s.id === sid ? { ...s, name: title } : s)) }).catch(() => {})
            }
          } else if (data.type === 'indexing_wait') {
            updateHistory(prev => prev.map(entry => entry.id === tempId ? { ...entry, indexingWait: true } : entry))
          } else if (data.type === 'hypothesis') {
            updateHistory(prev => prev.map(entry => entry.id === tempId ? { ...entry, hypothesis: data.text, indexingWait: false } : entry))
          } else if (data.type === 'eval') {
            setSessions(prev => prev.map(s => ({ ...s, history: s.history.map(entry => entry.id === tempId ? { ...entry, eval: { faithfulness: data.faithfulness, answer_relevance: data.answer_relevance } } : entry) })))
          } else if (data.type === 'error') { throw new Error(data.message) }
        }
      }
    } catch (err) {
      if (!pendingIdRef.current) return
      setQuestion(currentQuestionRef.current)
      const msg = err.message || ''
      const isRateLimit  = msg.toLowerCase().includes('rate limit')
      const isDailyLimit = isRateLimit && (msg.toLowerCase().includes('per day') || msg.toLowerCase().includes('tpd') || msg.toLowerCase().includes('tomorrow'))
      updateHistory(prev => prev.map(entry => entry.id === tempId
        ? { ...entry, answer: isRateLimit ? '' : `Error: ${msg}`, rateLimitError: isRateLimit, rateLimitDaily: isDailyLimit }
        : entry))
      authFetch(`${API}/dashboard`).then(r => r.json()).then(d => { setTokenStats(d.tokens); if (d.groq_tokens) setGroqTokens(d.groq_tokens) }).catch(() => {})
    } finally {
      if (pendingIdRef.current === tempId) {
        pendingIdRef.current = null; isLoadingRef.current = false; setIsLoading(false); abortControllerRef.current = null
      }
    }
  }, [question, scrollToBottom, updateHistory, sessionFileNames, activeSession, authFetch])

  const openDashboard = useCallback(async () => {
    setShowDashboard(true); setEvalData(null); setChunkView({}); setSummaryView({})
    try { const res = await authFetch(`${API}/dashboard`); setDashboardData(await res.json()) }
    catch { setDashboardData(null) }
  }, [authFetch])

  const runEval = useCallback(async () => {
    setEvalLoading(true); setEvalData(null)
    try {
      const res  = await authFetch(`${API}/eval`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Eval failed')
      setEvalData(data)
    } catch (e) { setEvalData({ error: e.message }) }
    finally { setEvalLoading(false) }
  }, [authFetch])

  const runQualityEval = useCallback(async () => {
    setQualityLoading(true); setQualityData(null)
    try {
      const params = new URLSearchParams({ provider })
      if (provider === 'cloud') params.set('groq_model', cloudModel)
      const res  = await authFetch(`${API}/eval/quality?${params}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Quality eval failed')
      setQualityData(data)
    } catch (e) { setQualityData({ error: e.message }) }
    finally { setQualityLoading(false) }
  }, [authFetch, provider, cloudModel])

  // ── Session list (derived) ─────────────────────────────────────────────────
  const filteredSessions = (() => {
    const q = sessionSearch.trim().toLowerCase()
    const list = q
      ? sessions.filter(s => s.name.toLowerCase().includes(q) || s.history.some(e => e.question?.toLowerCase().includes(q) || e.answer?.toLowerCase().includes(q)))
      : sessions
    if (list.length === 0) return (
      <p className="text-xs text-muted-foreground text-center py-4">No chats match "{sessionSearch}"</p>
    )
    return list.map(s => {
      const match = q ? s.history.find(e => e.question?.toLowerCase().includes(q) || e.answer?.toLowerCase().includes(q)) : null
      let excerpt = null
      if (match) {
        const src = match.question?.toLowerCase().includes(q) ? match.question : match.answer
        const idx = src.toLowerCase().indexOf(q)
        const start = Math.max(0, idx - 20)
        excerpt = (start > 0 ? '…' : '') + src.slice(start, idx + q.length + 35).trim() + '…'
      }
      const msgCount = s.history.filter(h => h.answer).length
      return (
        <button
          key={s.id}
          onClick={() => switchSession(s.id)}
          className={cn(
            'w-full text-left rounded-lg px-3 py-2.5 mb-1 group transition-colors relative',
            s.id === activeSession?.id
              ? 'bg-primary/10 text-foreground'
              : 'hover:bg-muted/60 text-foreground'
          )}
        >
          <div className="flex items-start justify-between gap-1">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{s.name}</div>
              {excerpt ? (
                <div className="text-[10px] text-muted-foreground truncate mt-0.5">{excerpt}</div>
              ) : (
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {s.fileNames.length} file{s.fileNames.length !== 1 ? 's' : ''} · {msgCount} msg{msgCount !== 1 ? 's' : ''}
                </div>
              )}
            </div>
            <button
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-destructive flex-shrink-0 mt-0.5"
              onClick={ev => { ev.stopPropagation(); if (window.confirm('Delete this chat?')) deleteSession(s.id) }}
              title="Delete"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </button>
      )
    })
  })()

  // ── File status helper ─────────────────────────────────────────────────────
  const fileStatusInfo = (status) => {
    switch (status) {
      case 'uploading': return { label: 'Uploading', className: 'text-muted-foreground' }
      case 'indexing':  return { label: 'Indexing',  className: 'text-amber-600 dark:text-amber-400' }
      case 'ready':     return { label: 'Ready',     className: 'text-emerald-600 dark:text-emerald-400' }
      case 'error':     return { label: 'Error',     className: 'text-destructive' }
      default:          return null
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen bg-background overflow-hidden">

        {/* ── Body ── */}
        <div className="flex flex-1 overflow-hidden">

          {/* ── Left panel (nav + sessions) ── */}
          {showLeftSidebar && (
          <aside className="w-64 flex-shrink-0 border-r flex flex-col bg-background z-10">

            {/* Panel header */}
            <div className="flex items-center justify-between px-3 h-11 border-b flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-primary rounded-md flex items-center justify-center flex-shrink-0">
                  <MessageSquare className="w-3 h-3 text-primary-foreground" />
                </div>
                <span className="font-bold text-sm uppercase tracking-wide">RAG Assistant</span>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 -mr-1" onClick={() => setShowLeftSidebar(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Nav controls */}
            <div className="flex items-center gap-1 px-2 py-2 border-b flex-shrink-0">
              <div className="flex items-center rounded-md border bg-muted p-0.5 gap-0.5">
                <button onClick={() => setProvider('local')} title="Local: qwen2.5:7b + qwen2.5vl:7b"
                  className={cn('flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all',
                    provider === 'local' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  <Cpu className="w-2.5 h-2.5" /> Local
                </button>
                <button onClick={() => setProvider('cloud')} title="Cloud: Llama 3.3 70B (Groq)"
                  className={cn('flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all',
                    provider === 'cloud' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  <Cloud className="w-2.5 h-2.5" /> Cloud
                </button>
              </div>
              <div className="flex-1" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDarkMode(d => !d)}>
                    {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Toggle theme</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={openDashboard}>
                    <BarChart2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Usage stats</TooltipContent>
              </Tooltip>
              {history.filter(e => e.answer !== null).length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => window.print()}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Export PDF</TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Cloud model selector */}
            {provider === 'cloud' && (
              <div className="px-3 py-2 border-b flex-shrink-0">
                <select
                  className="w-full bg-background text-foreground text-xs border border-border rounded px-2 py-1.5 cursor-pointer outline-none"
                  value={cloudModel}
                  onChange={e => setCloudModel(e.target.value)}
                >
                  <optgroup label="Llama 3">
                    <option value="llama-3.3-70b-versatile">Llama 3.3 70B</option>
                    <option value="llama-3.1-8b-instant">Llama 3.1 8B (fast)</option>
                  </optgroup>
                  <optgroup label="Llama 4">
                    <option value="meta-llama/llama-4-scout-17b-16e-instruct">Llama 4 Scout 17B</option>                  </optgroup>
                  <optgroup label="Other">                  </optgroup>
                </select>
              </div>
            )}

            {/* Groq token indicator — active model + expandable all-models */}
            {provider === 'cloud' && (() => {
              const activeModelDef = CLOUD_MODELS.find(m => m.key === cloudModel) || CLOUD_MODELS[0]
              const renderDonut = (model, label, limit, isActive) => {
                const data = groqTokens?.models?.[model]
                const used = data?.total ?? 0
                const dailyLimit = data?.daily_limit ?? limit
                const pct = Math.min(Math.round(used / Math.max(dailyLimit, 1) * 100), 100)
                const tpmPct = (data?.tpm_limit != null && data?.tpm_remaining != null)
                  ? Math.min(100, Math.round((1 - data.tpm_remaining / data.tpm_limit) * 100)) : null
                const tpmLow = tpmPct != null && tpmPct >= 80
                const fillColor = tpmLow || pct >= 90 ? '#ef4444' : pct >= 60 ? '#f59e0b' : '#22c55e'
                const trackColor = '#27272a'
                const r = 13; const circ = 2 * Math.PI * r
                return (
                  <div key={model} className="flex items-center gap-2.5" title={`${model}\n${used.toLocaleString()} / ${dailyLimit.toLocaleString()} tpd`}>
                    <div className="relative flex-shrink-0 w-8 h-8 flex items-center justify-center">
                      <svg width="32" height="32" className="absolute inset-0">
                        <circle cx="16" cy="16" r={r} fill="none" stroke={trackColor} strokeWidth="2.5" />
                        {pct > 0 && (
                          <circle cx="16" cy="16" r={r} fill="none" stroke={fillColor} strokeWidth="2.5"
                            strokeDasharray={circ} strokeDashoffset={circ * (1 - pct / 100)}
                            strokeLinecap="round" transform="rotate(-90 16 16)"
                            style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
                        )}
                      </svg>
                      <span className="text-[8px] font-bold relative z-10" style={{ color: pct > 0 ? fillColor : '#52525b' }}>{pct}%</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-medium text-foreground">{label}</div>
                      <div className="text-[9px] text-muted-foreground truncate">
                        {used.toLocaleString()} / {dailyLimit.toLocaleString()} tpd{tpmLow ? ' ⚠' : ''}
                      </div>
                    </div>
                  </div>
                )
              }
              return (
                <div className="border-b flex-shrink-0">
                  {/* Active model row + toggle */}
                  <div className="px-3 py-2.5 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      {renderDonut(activeModelDef.key, activeModelDef.label, activeModelDef.limit, true)}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className={cn('flex-shrink-0 p-1 rounded transition-colors', showAllModels ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
                          onClick={() => setShowAllModels(p => !p)}
                        >
                          <BarChart2 className="w-3.5 h-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{showAllModels ? 'Hide all models' : 'Show all models'}</TooltipContent>
                    </Tooltip>
                  </div>
                  {/* Expanded: all models */}
                  {showAllModels && (
                    <div className="px-3 pb-2.5 space-y-2.5 border-t pt-2.5 overflow-y-auto" style={{ maxHeight: '260px' }}>
                      {CLOUD_MODELS.map(({ key: model, label, limit }) => (
                        <div key={model} className={cn('transition-opacity', model === cloudModel ? 'opacity-100' : 'opacity-55')}>
                          {renderDonut(model, label, limit, model === cloudModel)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* New chat + search */}
            <div className="p-2 space-y-2 flex-shrink-0">
              <Button className="w-full justify-start gap-2 h-8 text-xs" variant="outline" onClick={createSession}>
                <Plus className="h-3.5 w-3.5" /> New chat
              </Button>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  className="pl-8 h-8 text-xs"
                  placeholder="Search chats…"
                  value={sessionSearch}
                  onChange={e => setSessionSearch(e.target.value)}
                />
                {sessionSearch && (
                  <button className="absolute right-2.5 top-1/2 -translate-y-1/2" onClick={() => setSessionSearch('')}>
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
              </div>
            </div>

            {/* Session list */}
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {filteredSessions}
            </div>

            {/* User footer */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-t flex-shrink-0">
              <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-[9px] font-semibold text-primary-foreground flex-shrink-0 select-none">
                {currentUser.firstname?.[0]}{currentUser.lastname?.[0]}
              </div>
              <span className="text-xs text-muted-foreground flex-1 truncate">{currentUser.firstname} {currentUser.lastname}</span>
              {anyIndexing && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground flex-shrink-0" />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onLogout}>
                    <LogOut className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Sign out</TooltipContent>
              </Tooltip>
            </div>
          </aside>
          )}
          {/* ── Chat area ── */}
          <main
            className="flex-1 flex flex-col overflow-hidden min-w-0 relative"
            onDragOver={ev => { ev.preventDefault(); setIsDragOver(true) }}
            onDragEnter={ev => { ev.preventDefault(); setIsDragOver(true) }}
            onDragLeave={ev => { if (!ev.currentTarget.contains(ev.relatedTarget)) setIsDragOver(false) }}
            onDrop={ev => { ev.preventDefault(); setIsDragOver(false); handleFileSelect(ev.dataTransfer.files) }}
          >
{/* Always-mounted file input */}
            <input
              ref={fileInputRef} type="file"
              accept=".pdf,.txt,.docx,.xlsx,.xls,.pptx,.puml,.plantuml,.uml,.md,.csv,image/*"
              multiple style={{ display: 'none' }}
              onChange={ev => { handleFileSelect(ev.target.files); ev.target.value = '' }}
            />

            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary pointer-events-none">
                <div className="flex flex-col items-center gap-3">
                  <Paperclip className="w-10 h-10 text-primary" />
                  <p className="text-sm font-medium text-primary">Drop files to upload</p>
                </div>
              </div>
            )}

            {/* ── Persistent top bar ── */}
            <div className="h-10 border-b flex items-center px-2 gap-1.5 flex-shrink-0 bg-background">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowLeftSidebar(p => !p)} title="Toggle panel">
                <Menu className="h-4 w-4" />
              </Button>
              {anyIndexing && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span className="hidden sm:inline">Indexing…</span>
                </span>
              )}
              <div className="flex-1" />
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowRightSidebar(p => !p)} title="Toggle files">
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>

            {/* Print header */}
            <div className="print-header hidden print:block px-6 py-4 border-b">
              <div className="font-semibold">RAG Assistant — Chat Export</div>
              <div className="text-sm text-muted-foreground">{new Date().toLocaleString()}</div>
            </div>

            {history.length === 0 && !isLoading ? (
              /* ── Empty state: centered input ── */
              <div className="flex-1 flex items-center justify-center px-6 pb-10 relative overflow-hidden">
                <Spotlight className="-top-20 left-1/2 -translate-x-1/2" fill="white" />
                <div className="w-full max-w-2xl space-y-5 relative z-10">

                  {/* Greeting */}
                  <div className="text-center select-none">
                    <TextGenerateEffect
                      words={`How can I help you today${currentUser.firstname ? `, ${currentUser.firstname}` : ''}?`}
                      className="text-2xl font-semibold tracking-tight"
                      duration={0.3}
                    />
                  </div>

                  {/* Suggestion cards */}
                  <HoverEffect
                    className="w-full"
                    items={[
                      { title: "Summarize my documents", description: "Get a quick overview of all uploaded files", onClick: () => setQuestion("Summarize the uploaded documents") },
                      { title: "Key concepts & terms", description: "Extract the main ideas and definitions", onClick: () => setQuestion("What are the key concepts and terms in these documents?") },
                      { title: "Compare & contrast", description: "Find similarities and differences across files", onClick: () => setQuestion("Compare and contrast the main topics across the uploaded documents") },
                    ]}
                  />

                  {/* Uploaded file chips */}
                  {sessionFiles.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 justify-center">
                      {sessionFiles.map(file => (
                        <div key={file.name}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-muted/50 text-xs text-muted-foreground max-w-[200px] group/chip">
                          {(file.status === 'indexing' || file.status === 'uploading') ? (
                            <Loader2 className="w-3 h-3 flex-shrink-0 text-amber-500 animate-spin" />
                          ) : (
                            <FileText className="w-3 h-3 flex-shrink-0 text-primary/70 cursor-pointer" onClick={() => setPreviewFile(file.name)} />
                          )}
                          <span
                            className={file.status === 'ready' ? 'truncate cursor-pointer hover:text-foreground' : 'truncate'}
                            onClick={() => file.status === 'ready' && setPreviewFile(file.name)}
                            title={file.name}
                          >{file.name}</span>
                          {(file.status === 'indexing' || file.status === 'uploading') && (
                            <span className="text-[9px] text-amber-500 flex-shrink-0">indexing</span>
                          )}
                          <button
                            className="ml-0.5 flex-shrink-0 opacity-0 group-hover/chip:opacity-100 transition-opacity hover:text-destructive"
                            onClick={e => { e.stopPropagation(); handleRemoveFile(file.name) }}
                            title="Remove"
                          ><X className="w-2.5 h-2.5" /></button>
                        </div>
                      ))}
                    </div>
                  )}

                  {showChatUrl && (
                    <form className="mb-2 flex gap-1.5" onSubmit={e => { handleUrlIngest(e, chatUrlInput); setChatUrlInput(''); setShowChatUrl(false) }}>
                      <Input autoFocus className="flex-1 h-8 text-xs" type="url" placeholder="Paste a URL to ingest…"
                        value={chatUrlInput} onChange={e => setChatUrlInput(e.target.value)} />
                      <Button type="submit" size="icon" variant="outline" className="h-8 w-8 flex-shrink-0" disabled={urlLoading || !chatUrlInput.trim()}>
                        {urlLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      </Button>
                      <Button type="button" size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0"
                        onClick={() => { setShowChatUrl(false); setChatUrlInput('') }}><X className="w-3 h-3" /></Button>
                    </form>
                  )}
                  <form onSubmit={handleSubmit}>
                    <div className="flex gap-2 items-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button type="button" variant="ghost" size="icon"
                            className="h-10 w-10 flex-shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() => fileInputRef.current?.click()}>
                            <Paperclip className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Attach file</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button type="button" variant="ghost" size="icon"
                            className={cn('h-10 w-10 flex-shrink-0', showChatUrl ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
                            onClick={() => setShowChatUrl(p => !p)}>
                            <Link2 className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Paste URL</TooltipContent>
                      </Tooltip>
                      <Input
                        className="flex-1 text-sm h-10"
                        placeholder="Ask a question about your documents…"
                        value={question}
                        onChange={e => setQuestion(e.target.value)}
                        onKeyDown={handleInputKeyDown}
                        autoComplete="off"
                      />
                      <ShimmerButton type="submit" className="h-10 w-10 flex-shrink-0 p-0" disabled={!question.trim()}>
                        <Send className="h-4 w-4" />
                      </ShimmerButton>
                    </div>
                  </form>
                </div>
              </div>
            ) : (
              /* ── Active state: messages + input ── */
              <>
                <div className="flex-1 overflow-y-auto px-4 py-6" ref={chatScrollRef}>
                  <div className="max-w-3xl mx-auto space-y-6">
                                {/* Message pairs */}
              {history.map(entry => (
                <div key={entry.id} id={`msg-${entry.id}`} className="space-y-3">
                  {/* User bubble */}
                  <div className="flex justify-end">
                    <div className="max-w-[75%] group">
                      <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed shadow-sm">
                        {entry.question}
                      </div>
                      <div className="flex justify-end items-center gap-2 mt-1 px-1">
                        {entry.sentAt && (
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(entry.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                        <button
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => navigator.clipboard.writeText(entry.question)}
                          title="Copy"
                        >
                          <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* AI response */}
                  <div className="flex justify-start">
                    <div className="max-w-[85%] flex items-start gap-2.5">
                      {/* AI avatar */}
                      <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <MessageSquare className="w-3.5 h-3.5 text-primary" />
                      </div>

                      <div className="flex-1 min-w-0 space-y-1.5">
                        {/* Answer content */}
                        {entry.answer === null ? (
                          <div className="bg-card border rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <div className="flex gap-1 items-center">
                                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                              </div>
                              <span className="text-xs">{entry.indexingWait ? 'Waiting for indexing…' : 'Generating response…'}</span>
                            </div>
                          </div>
                        ) : entry.rateLimitError ? (
                          <div className="bg-destructive/10 border border-destructive/20 rounded-2xl rounded-tl-sm px-4 py-3 flex items-start gap-3">
                            <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                            <div>
                              <div className="font-medium text-sm text-destructive">Rate limit reached</div>
                              <div className="text-xs text-destructive/80 mt-0.5 leading-relaxed">
                                {entry.rateLimitDaily
                                  ? "Groq's daily token quota is exhausted. Try again tomorrow or switch to a different model."
                                  : "Groq's per-minute limit was hit. Wait 1–2 minutes and try again, or reduce context by removing documents."}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="group">
                            <div className="markdown-body text-sm">
                              <ReactMarkdown>{entry.answer}</ReactMarkdown>
                            </div>
                            {entry.stopped && (
                              <div className="flex items-center gap-1 text-xs text-muted-foreground mt-2">
                                <Square className="w-3 h-3" /> Stopped
                              </div>
                            )}
                            <button
                              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground mt-2 transition-colors opacity-0 group-hover:opacity-100"
                              onClick={() => navigator.clipboard.writeText(entry.answer)}
                            >
                              <Copy className="w-3 h-3" /> Copy
                            </button>
                          </div>
                        )}

                        {/* Warning */}
                        {entry.warning && (
                          <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-400 leading-relaxed">
                            ⚠ {entry.warning}
                          </div>
                        )}

                        {/* Sources */}
                        {entry.sources?.length > 0 && entry.answer !== null && (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {(entry.citations?.length > 0 ? entry.citations : entry.sources.map(s => ({ file: s, pages: [] }))).map((c, i) => (
                              <Badge key={i} variant="secondary" className="text-[10px] font-normal gap-1 py-0.5 h-auto">
                                <FileText className="w-2.5 h-2.5" />
                                <span className="max-w-[160px] truncate">{c.file}</span>
                                {c.pages?.length > 0 && <span className="text-muted-foreground">p.{c.pages.join(',')}</span>}
                              </Badge>
                            ))}
                          </div>
                        )}

                        {/* Eval badges + hypothesis toggle */}
                        {(entry.eval || entry.hypothesis) && entry.answer !== null && (
                          <div className="space-y-1.5">
                            <div className="flex gap-1.5 pt-0.5 items-center flex-wrap">
                              {entry.eval && (
                                <>
                                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded border font-medium', evalBadgeClass(entry.eval.faithfulness))}
                                    title="Faithfulness">
                                    F {Math.round(entry.eval.faithfulness * 100)}%
                                  </span>
                                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded border font-medium', evalBadgeClass(entry.eval.answer_relevance))}
                                    title="Answer relevance">
                                    R {Math.round(entry.eval.answer_relevance * 100)}%
                                  </span>
                                </>
                              )}
                              {entry.hypothesis && (
                                <button
                                  className={cn('flex items-center justify-center w-5 h-5 rounded border transition-colors',
                                    hypothesisOpenId === entry.id
                                      ? 'text-foreground border-foreground/30 bg-muted'
                                      : 'text-muted-foreground border-border hover:text-foreground hover:border-foreground/30')}
                                  onClick={() => setHypothesisOpenId(hypothesisOpenId === entry.id ? null : entry.id)}
                                  title="Search hypothesis"
                                ><Search className="w-2.5 h-2.5" /></button>
                              )}
                            </div>
                            {hypothesisOpenId === entry.id && entry.hypothesis && (
                              <div className="text-xs rounded-lg bg-muted/60 border px-3 py-2 text-muted-foreground leading-relaxed">
                                <span className="text-[10px] font-medium text-foreground/60 block mb-1">Search hypothesis</span>
                                {entry.hypothesis}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
                  </div>
                </div>

                {/* Scroll to bottom */}
                {showScrollDown && (
                  <button
                    className="absolute bottom-28 left-1/2 -translate-x-1/2 bg-background border shadow-md rounded-full p-2 hover:bg-muted transition-colors z-10"
                    onClick={scrollToBottom}
                    title="Scroll to latest"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                )}

                {/* Input bar */}
                <div className="border-t bg-background px-4 pt-3 pb-4 flex-shrink-0">
                  {/* File chips above input */}
                  {sessionFiles.length > 0 && (
                    <div className="max-w-3xl mx-auto mb-2 flex flex-wrap gap-1.5">
                      {sessionFiles.map(file => (
                        <div key={file.name}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-muted/50 text-xs text-muted-foreground max-w-[200px] group/chip"
                          title={file.name}>
                          {(file.status === 'indexing' || file.status === 'uploading') ? (
                            <Loader2 className="w-3 h-3 flex-shrink-0 text-amber-500 animate-spin" />
                          ) : (
                            <FileText className="w-3 h-3 flex-shrink-0 text-primary/70 cursor-pointer" onClick={() => setPreviewFile(file.name)} />
                          )}
                          <span
                            className={file.status === 'ready' ? 'truncate cursor-pointer hover:text-foreground' : 'truncate'}
                            onClick={() => file.status === 'ready' && setPreviewFile(file.name)}
                            title={file.name}
                          >{file.name}</span>
                          {(file.status === 'indexing' || file.status === 'uploading') && (
                            <span className="text-[9px] text-amber-500 flex-shrink-0">indexing</span>
                          )}
                          <button
                            className="ml-0.5 flex-shrink-0 opacity-0 group-hover/chip:opacity-100 transition-opacity hover:text-destructive"
                            onClick={e => { e.stopPropagation(); handleRemoveFile(file.name) }}
                            title="Remove"
                          ><X className="w-2.5 h-2.5" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  {showChatUrl && (
                    <form className="max-w-3xl mx-auto mb-2 flex gap-1.5" onSubmit={e => { handleUrlIngest(e, chatUrlInput); setChatUrlInput(''); setShowChatUrl(false) }}>
                      <Input autoFocus className="flex-1 h-8 text-xs" type="url" placeholder="Paste a URL to ingest…"
                        value={chatUrlInput} onChange={e => setChatUrlInput(e.target.value)} />
                      <Button type="submit" size="icon" variant="outline" className="h-8 w-8 flex-shrink-0" disabled={urlLoading || !chatUrlInput.trim()}>
                        {urlLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      </Button>
                      <Button type="button" size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0"
                        onClick={() => { setShowChatUrl(false); setChatUrlInput('') }}><X className="w-3 h-3" /></Button>
                    </form>
                  )}
                  <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
                    <div className="flex gap-2 items-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button type="button" variant="ghost" size="icon"
                            className="h-10 w-10 flex-shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() => fileInputRef.current?.click()}>
                            <Paperclip className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Attach file</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button type="button" variant="ghost" size="icon"
                            className={cn('h-10 w-10 flex-shrink-0', showChatUrl ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
                            onClick={() => setShowChatUrl(p => !p)}>
                            <Link2 className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Paste URL</TooltipContent>
                      </Tooltip>
                      <Input
                        className="flex-1 text-sm h-10"
                        placeholder="Ask a question about your documents…"
                        value={question}
                        onChange={e => setQuestion(e.target.value)}
                        onKeyDown={handleInputKeyDown}
                        disabled={isLoading}
                        autoComplete="off"
                      />
                      {isLoading ? (
                        <Button type="button" variant="destructive" size="icon" className="h-10 w-10 flex-shrink-0" onClick={handleCancel} title="Cancel">
                          <Square className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button type="submit" size="icon" className="h-10 w-10 flex-shrink-0" disabled={!question.trim()}>
                          <Send className="h-4 w-4" />
                        </Button>
                      )}
                    </div>

                    {tokenStats && tokenStats.total > 0 && (() => {
                      const model = COST_MODELS.find(m => m.name === selectedCostModel) || COST_MODELS[0]
                      const cost  = (tokenStats.prompt / 1e6) * model.input + (tokenStats.completion / 1e6) * model.output
                      return (
                        <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                          <span>Est. cost on</span>
                          <select
                            className="bg-background text-foreground text-xs cursor-pointer outline-none border border-border rounded px-1 py-0.5"
                            value={selectedCostModel}
                            onChange={e => setSelectedCostModel(e.target.value)}
                          >
                            {COST_MODELS.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                          </select>
                          <span className="font-medium text-foreground">{cost < 0.0001 ? '<$0.0001' : `$${cost.toFixed(4)}`}</span>
                          <span>· {tokenStats.total.toLocaleString()} tokens</span>
                        </div>
                      )
                    })()}
                  </form>
                </div>
              </>
            )}
          </main>

          {/* ── File sidebar ── */}
          {showRightSidebar && (
          <aside className="w-72 flex-shrink-0 border-l flex flex-col bg-background">

            {/* Tab switcher */}
            <div className="flex flex-shrink-0 border-b">
              {['files', 'usage'].map(tab => (
                <button key={tab}
                  className={cn('flex-1 py-2 text-xs font-medium capitalize transition-colors border-b-2 -mb-px',
                    rightSidebarTab === tab
                      ? 'text-foreground border-primary'
                      : 'text-muted-foreground border-transparent hover:text-foreground')}
                  onClick={() => setRightSidebarTab(tab)}>{tab}</button>
              ))}
            </div>

            {rightSidebarTab === 'usage' ? (
              /* ── Usage tab ── */
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
                <div className="flex items-center rounded-md border bg-muted p-0.5 gap-0.5 w-fit">
                  {['daily', 'monthly'].map(p => (
                    <button key={p} onClick={() => setUsagePeriod(p)}
                      className={cn('px-3 py-1 rounded text-[10px] font-medium capitalize transition-all',
                        usagePeriod === p ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                      {p}
                    </button>
                  ))}
                </div>
                {(() => {
                  const key = `rag-usage-${currentUser?.email || 'default'}`
                  let raw = {}
                  try { raw = JSON.parse(localStorage.getItem(key) || '{}') } catch {}
                  let chartData = []
                  if (usagePeriod === 'daily') {
                    chartData = Object.entries(raw).sort(([a],[b]) => a.localeCompare(b)).slice(-14)
                      .map(([date, d]) => ({ label: date.slice(5), tokens: d.total || 0, prompt: d.prompt || 0, completion: d.completion || 0 }))
                  } else {
                    const byMonth = {}
                    Object.entries(raw).forEach(([date, d]) => {
                      const m = date.slice(0, 7)
                      byMonth[m] = Math.max(byMonth[m] || 0, d.total || 0)
                    })
                    chartData = Object.entries(byMonth).sort(([a],[b]) => a.localeCompare(b)).slice(-6)
                      .map(([month, tokens]) => ({ label: month.slice(5), tokens }))
                  }
                  if (chartData.length === 0) return (
                    <div className="text-xs text-muted-foreground text-center py-10 leading-relaxed">
                      No usage data yet.<br />Start chatting to see your stats.
                    </div>
                  )
                  const total = chartData.reduce((a, d) => a + d.tokens, 0)
                  const last = chartData[chartData.length - 1]
                  return (
                    <div className="space-y-3">
                      <div className="rounded-lg border bg-card px-4 py-3">
                        <div className="text-xl font-bold">{total.toLocaleString()}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {usagePeriod === 'daily' ? 'Tokens — last 14 days' : 'Peak tokens — last 6 months'}
                        </div>
                      </div>
                      <div className="h-40">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                            <defs>
                              <linearGradient id="usageGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#a855f7" stopOpacity={0.25} />
                                <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#71717a' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                            <RechartTooltip
                              contentStyle={{ backgroundColor: 'var(--background)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '10px', padding: '6px 10px' }}
                              labelStyle={{ color: '#71717a', marginBottom: '2px' }}
                              formatter={(v) => [v.toLocaleString() + ' tokens', 'Usage']}
                            />
                            <Area type="monotone" dataKey="tokens" stroke="#a855f7" strokeWidth={1.5} fill="url(#usageGrad)" dot={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                      {usagePeriod === 'daily' && last && (
                        <div className="grid grid-cols-2 gap-2">
                          {[
                            { label: 'Prompt (today)', value: last.prompt },
                            { label: 'Completion (today)', value: last.completion },
                          ].map(({ label, value }) => (
                            <div key={label} className="rounded-lg border bg-card px-3 py-2.5 text-center">
                              <div className="text-sm font-bold">{(value || 0).toLocaleString()}</div>
                              <div className="text-[9px] text-muted-foreground mt-0.5">{label}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            ) : (
              /* ── Files tab ── */
              <>
            {/* Prompt nav */}
            {history.filter(e => e.question).length > 0 && (
              <div className="border-b flex-shrink-0">
                <button
                  className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-medium hover:bg-muted/50 transition-colors"
                  onClick={() => setShowPromptNav(p => !p)}
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <BookOpen className="w-3.5 h-3.5" /> Prompts
                  </span>
                  {showPromptNav ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
                {showPromptNav && (
                  <div className="border-t max-h-40 overflow-y-auto">
                    {history.filter(e => e.question).map((entry, idx) => (
                      <button
                        key={entry.id}
                        className="w-full text-left px-4 py-2 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex gap-2 items-start"
                        onClick={() => document.getElementById(`msg-${entry.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      >
                        <span className="flex-shrink-0 w-4 h-4 rounded bg-muted text-[9px] flex items-center justify-center font-medium">{idx + 1}</span>
                        <span className="truncate">{entry.question.length > 50 ? entry.question.slice(0, 50) + '…' : entry.question}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Documents header */}
            <div className="px-4 pt-4 pb-2 flex-shrink-0">
              {/* URL ingest */}
              <form className="flex gap-1.5 mt-2" onSubmit={handleUrlIngest}>
                <div className="relative flex-1">
                  <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                  <Input
                    className="pl-7 h-8 text-xs"
                    type="url"
                    placeholder="Paste a URL…"
                    value={urlInput}
                    onChange={e => { setUrlInput(e.target.value); setUrlError('') }}
                    disabled={urlLoading}
                  />
                </div>
                <Button type="submit" size="icon" variant="outline" className="h-8 w-8 flex-shrink-0"
                  disabled={urlLoading || !urlInput.trim()}>
                  {urlLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                </Button>
              </form>
              {urlError && <p className="text-xs text-destructive mt-1">{urlError}</p>}
            </div>

            {/* File list */}
            <div className="flex-1 overflow-y-auto px-3 pb-4">
              {sessionFiles.length > 0 && (
                <div className="space-y-1.5 mt-1">
                  {sessionFiles.map(file => {
                    const info = fileStatusInfo(file.status)
                    return (
                      <div
                        key={file.name}
                        className={cn(
                          'group rounded-lg border bg-card px-3 py-2.5 transition-colors',
                          file.status === 'ready' ? 'cursor-pointer hover:border-primary/40 hover:bg-muted/30' : ''
                        )}
                        onClick={() => { if (file.status === 'ready') setPreviewFile(file.name) }}
                      >
                        <div className="flex items-start gap-2">
                          <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium truncate" title={file.name}>{file.name}</div>
                            <div className={cn('text-[10px] mt-0.5', info?.className || 'text-muted-foreground')}>
                              {info?.label || formatFileSize(file.size)}
                            </div>

                            {/* Progress bar */}
                            {(file.status === 'indexing' || file.status === 'uploading') && file.progress && file.progress.total > 0 && (
                              <div className="mt-1.5">
                                <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                                  <div className="h-full bg-amber-500 rounded-full transition-all"
                                    style={{ width: `${Math.round((file.progress.current / file.progress.total) * 100)}%` }} />
                                </div>
                                <span className="text-[9px] text-muted-foreground">
                                  Page {file.progress.current}/{file.progress.total}
                                </span>
                              </div>
                            )}

                            {/* Cancel indexing */}
                            {file.status === 'indexing' && (
                              <button
                                className="text-[10px] text-muted-foreground hover:text-destructive mt-1 underline"
                                onClick={e => { e.stopPropagation(); handleCancelIndexing(file.name) }}
                              >
                                cancel
                              </button>
                            )}
                          </div>

                          {/* Actions */}
                          {file.status === 'ready' && (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    className="p-1 rounded hover:bg-muted transition-colors"
                                    onClick={e => { e.stopPropagation(); handleReindexFile(file.name) }}
                                  >
                                    <RotateCcw className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>Re-index</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    className="p-1 rounded hover:bg-muted transition-colors"
                                    onClick={e => { e.stopPropagation(); handleRemoveFile(file.name) }}
                                  >
                                    <X className="w-3 h-3 text-muted-foreground hover:text-destructive" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>Remove</TooltipContent>
                              </Tooltip>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
              </>
            )}
          </aside>
          )}
        </div>

        {/* ── Dashboard Sheet ── */}
        <Sheet open={showDashboard} onOpenChange={setShowDashboard}>
          <SheetContent className="w-[520px] sm:max-w-none overflow-y-auto p-0" side="right">
            <SheetHeader className="px-6 py-4 border-b sticky top-0 bg-background z-10">
              <SheetTitle>Usage Stats</SheetTitle>
            </SheetHeader>
            <div className="px-6 py-5 space-y-6">
              {!dashboardData ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  {/* Stats cards */}
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: 'Questions asked',   value: dashboardData.queries?.total ?? totalQuestions },
                      { label: 'Avg response time', value: dashboardData.queries?.avg_response_ms ? `${(dashboardData.queries.avg_response_ms / 1000).toFixed(1)}s` : '—' },
                      { label: 'Documents ready',   value: dashboardData.documents.ready },
                      { label: 'Total chunks',      value: dashboardData.chunks.total },
                    ].map(({ label, value }) => (
                      <div key={label} className="rounded-lg border bg-card p-4">
                        <div className="text-2xl font-bold">{value}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* RAG quality */}
                  {evalEntries.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                        RAG Quality — avg over {evalEntries.length} response{evalEntries.length !== 1 ? 's' : ''}
                      </h3>
                      <div className="grid grid-cols-2 gap-3">
                        {[
                          { label: 'Avg Faithfulness', value: avgFaithfulness, title: 'How well answers are grounded in retrieved context' },
                          { label: 'Avg Relevance',    value: avgRelevance,    title: 'How directly answers address the questions' },
                        ].map(({ label, value, title }) => (
                          <div key={label} className="rounded-lg border bg-card p-4" title={title}>
                            <div className={cn('text-2xl font-bold', evalBadgeClass(value).split(' ')[0])}>
                              {Math.round(value * 100)}%
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Active models */}
                  <div>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Active Models</h3>
                    <div className="rounded-lg border divide-y">
                      {[['LLM', provider === 'cloud' ? cloudModel : dashboardData.models.llm], ['Embeddings', dashboardData.models.embed], ['Vision', dashboardData.models.vision]].map(([label, value]) => (
                        <div key={label} className="flex items-center justify-between px-4 py-2.5">
                          <span className="text-xs text-muted-foreground">{label}</span>
                          <code className="text-xs bg-muted px-2 py-0.5 rounded">{value}</code>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Token usage */}
                  <div>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Token Usage (session)</h3>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: 'Prompt',     value: dashboardData.tokens.prompt.toLocaleString() },
                        { label: 'Completion', value: dashboardData.tokens.completion.toLocaleString() },
                        { label: 'Total',      value: dashboardData.tokens.total.toLocaleString() },
                      ].map(({ label, value }) => (
                        <div key={label} className="rounded-lg border bg-card px-3 py-3 text-center">
                          <div className="text-lg font-bold">{value}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Cost estimate */}
                  {dashboardData.tokens.total > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Estimated Cost</h3>
                      <div className="rounded-lg border divide-y">
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
                            <div key={model} className="flex items-center justify-between px-4 py-2">
                              <span className="text-xs text-muted-foreground">{model}</span>
                              <span className="text-xs font-medium">{cost < 0.001 ? '<$0.001' : `$${cost.toFixed(4)}`}</span>
                            </div>
                          )
                        })}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-2">Prices per 1M tokens. Resets on server restart.</p>
                    </div>
                  )}

                  {/* Documents */}
                  {Object.keys(dashboardData.documents.file_chunks).length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Documents</h3>
                      <div className="rounded-lg border divide-y">
                        {Object.entries(dashboardData.documents.file_chunks).map(([name, chunks]) => {
                          const cv = chunkView[name] || {}
                          const sv = summaryView[name] || {}

                          const toggleChunks = async () => {
                            if (cv.open) { setChunkView(p => ({ ...p, [name]: { ...p[name], open: false } })); return }
                            if (cv.chunks) { setChunkView(p => ({ ...p, [name]: { ...p[name], open: true } })); return }
                            setChunkView(p => ({ ...p, [name]: { open: true, loading: true, chunks: null } }))
                            try {
                              const res  = await authFetch(`${API}/debug/chunks/${encodeURIComponent(name)}`)
                              const data = await res.json()
                              setChunkView(p => ({ ...p, [name]: { open: true, loading: false, chunks: data.chunks || [] } }))
                            } catch { setChunkView(p => ({ ...p, [name]: { open: true, loading: false, chunks: [] } })) }
                          }

                          const summarize = async (e) => {
                            e.stopPropagation()
                            if (sv.loading) return
                            if (sv.text) { setSummaryView(p => ({ ...p, [name]: { ...p[name], text: null } })); return }
                            setSummaryView(p => ({ ...p, [name]: { loading: true, text: null } }))
                            try {
                              let accumulated = ''
                              const res = await authFetch(`${API}/ask`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ question: 'Résume ce document complètement : couvre tous les sujets principaux, points clés et détails importants. Ne saute rien.', files: [name], history: [] }),
                              })
                              const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = ''
                              while (true) {
                                const { done, value } = await reader.read(); if (done) break
                                buf += decoder.decode(value, { stream: true })
                                const lines = buf.split('\n'); buf = lines.pop()
                                for (const line of lines) {
                                  if (!line.startsWith('data: ')) continue
                                  try { const msg = JSON.parse(line.slice(6)); if (msg.type === 'token') accumulated += msg.content } catch {}
                                }
                                setSummaryView(p => ({ ...p, [name]: { loading: false, text: accumulated || '…' } }))
                              }
                            } catch { setSummaryView(p => ({ ...p, [name]: { loading: false, text: 'Error generating summary.' } })) }
                          }

                          return (
                            <div key={name}>
                              <div className="px-4 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors" onClick={toggleChunks}>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <ChevronDown className={cn('w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform', cv.open ? '' : '-rotate-90')} />
                                    <span className="text-xs truncate">{name}</span>
                                  </div>
                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    <button
                                      onClick={summarize}
                                      className={cn(
                                        'text-[10px] px-2 py-0.5 rounded border transition-colors',
                                        sv.text ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground hover:text-foreground border-border hover:border-foreground/30',
                                        sv.loading ? 'opacity-60' : ''
                                      )}
                                      title="Generate a summary"
                                    >
                                      {sv.loading ? '…' : sv.text ? '✕ Summary' : '∑ Summarize'}
                                    </button>
                                    <span className="text-[10px] text-muted-foreground">{chunks} chunks</span>
                                  </div>
                                </div>
                              </div>

                              {sv.text && (
                                <div className="mx-4 mb-3 p-3 bg-muted/50 rounded-lg border-l-2 border-primary text-xs leading-relaxed text-foreground whitespace-pre-wrap">
                                  <span className="text-[10px] text-muted-foreground font-medium block mb-1">Summary — {name}</span>
                                  {sv.text}
                                </div>
                              )}

                              {cv.open && (
                                <div className="mx-4 mb-3 space-y-2">
                                  {cv.loading && <p className="text-xs text-muted-foreground italic">Loading chunks…</p>}
                                  {cv.chunks && cv.chunks.length === 0 && <p className="text-xs text-muted-foreground">No chunks found.</p>}
                                  {cv.chunks && cv.chunks.map((text, i) => (
                                    <div key={i} className="p-2.5 bg-muted/50 rounded-lg border-l-2 border-primary/40 text-xs leading-relaxed whitespace-pre-wrap">
                                      <span className="text-[9px] text-muted-foreground font-medium block mb-1">Chunk {i + 1}</span>
                                      {text}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Retrieval eval */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Retrieval Evaluation</h3>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={runEval} disabled={evalLoading}>
                        {evalLoading ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Running…</> : 'Run eval'}
                      </Button>
                    </div>

                    {!evalData && !evalLoading && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Measures Hit Rate, Precision, MRR and Recall against <code className="text-[11px]">eval_dataset.json</code>.
                        Make sure dataset files are indexed before running.
                      </p>
                    )}
                    {evalLoading && <p className="text-xs text-muted-foreground italic">Running retrieval for each question — this may take 30–60 s…</p>}
                    {evalData?.error && <p className="text-xs text-destructive">{evalData.error}</p>}

                    {evalData && !evalData.error && (
                      <div className="space-y-3">
                        {evalData.configurations && (
                          <div className="rounded-lg border overflow-hidden">
                            <div className="grid grid-cols-3 bg-muted px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase">
                              <span>Configuration</span>
                              <span className="text-right">Hit@{evalData.top_k}</span>
                              <span className="text-right">MRR</span>
                            </div>
                            {evalData.configurations.map(cfg => (
                              <div key={cfg.name} className={cn('grid grid-cols-3 px-3 py-2 divide-x-0 border-t text-xs', cfg.name === 'Hybrid + Reranker' ? 'bg-primary/5 font-medium' : '')}>
                                <span className="text-muted-foreground">{cfg.name}</span>
                                <span className="text-right">{(cfg.hit_rate * 100).toFixed(0)}%</span>
                                <span className="text-right">{cfg.mrr.toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="rounded-lg border overflow-hidden">
                          <div className="grid grid-cols-4 bg-muted px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase">
                            <span className="col-span-2">Question</span>
                            <span className="text-center">Hit</span>
                            <span className="text-right">MRR</span>
                          </div>
                          {evalData.per_question.map(r => (
                            <div key={r.id}>
                              <div
                                className="grid grid-cols-4 px-3 py-2 border-t text-xs cursor-pointer hover:bg-muted/50 transition-colors"
                                onClick={() => setEvalSelectedQ(evalSelectedQ === r.id ? null : r.id)}
                              >
                                <span className="col-span-2 text-muted-foreground truncate">{r.id}</span>
                                <span className={cn('text-center font-semibold', r.hit ? 'text-emerald-600' : 'text-destructive')}>
                                  {r.hit ? '✓' : '✗'}
                                </span>
                                <span className="text-right text-muted-foreground">{r.mrr.toFixed(2)}</span>
                              </div>
                              {evalSelectedQ === r.id && (
                                <div className="mx-3 mb-2 p-3 bg-muted/50 rounded-lg border text-xs space-y-2">
                                  <div>
                                    <div className="text-[10px] text-muted-foreground font-medium mb-0.5">Question</div>
                                    <div>{r.question}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] text-muted-foreground font-medium mb-0.5">Expected source</div>
                                    <div>{(r.source_files || []).join(', ') || '—'}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] text-muted-foreground font-medium mb-1">Retrieved</div>
                                    <div className="space-y-1">
                                      {(r.retrieved || []).map((chunk, i) => (
                                        <div key={i} className={cn('flex items-center gap-1.5', chunk.hit ? 'text-emerald-600' : 'text-muted-foreground')}>
                                          <span>{chunk.hit ? '✓' : '✗'}</span>
                                          <span>{chunk.file}{chunk.page && chunk.page !== '?' ? ` (p.${chunk.page})` : ''}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <p className="text-[10px] text-muted-foreground">{evalData.n_questions} questions · click a row to inspect retrieved chunks</p>
                      </div>
                    )}
                  </div>

                  {/* ── Answer Quality eval ─────────────────────────────── */}
                  <div className="border-t pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Answer Quality</h3>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={runQualityEval} disabled={qualityLoading}>
                        {qualityLoading ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Running…</> : 'Run quality eval'}
                      </Button>
                    </div>
                    {!qualityData && !qualityLoading && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Runs 15 LLM-graded questions through the full RAG pipeline and scores faithfulness, relevance, and correctness vs expected answers. Uses current provider ({provider === 'cloud' ? cloudModel : 'local'}).
                      </p>
                    )}
                    {qualityLoading && <p className="text-xs text-muted-foreground italic">Generating and scoring answers — ~2–3 min for 15 questions…</p>}
                    {qualityData?.error && <p className="text-xs text-destructive">{qualityData.error}</p>}
                    {qualityData && !qualityData.error && (() => {
                      const sc = v => v >= 0.8 ? 'text-emerald-600' : v >= 0.5 ? 'text-amber-500' : 'text-destructive'
                      return (
                        <div className="space-y-3">
                          <div className="grid grid-cols-3 gap-2">
                            {[['Faithfulness', qualityData.avg_faithfulness], ['Relevance', qualityData.avg_relevance], ['Correctness', qualityData.avg_correctness]].map(([label, val]) => (
                              <div key={label} className="rounded-lg border p-2 text-center">
                                <div className={cn('text-lg font-bold tabular-nums', sc(val))}>{Math.round(val * 100)}%</div>
                                <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
                              </div>
                            ))}
                          </div>
                          <p className="text-[10px] text-muted-foreground">Model: {qualityData.model} · {qualityData.n_questions} questions</p>
                          <div className="rounded-lg border overflow-hidden">
                            <div className="grid grid-cols-4 bg-muted px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase">
                              <span className="col-span-2">Question</span><span className="text-center">F/R</span><span className="text-right">Corr</span>
                            </div>
                            {qualityData.per_question.map(r => (
                              <div key={r.id}>
                                <div className="grid grid-cols-4 px-3 py-2 border-t text-xs cursor-pointer hover:bg-muted/50 transition-colors"
                                     onClick={() => setQualitySelectedQ(qualitySelectedQ === r.id ? null : r.id)}>
                                  <span className="col-span-2 text-muted-foreground truncate">{r.id}</span>
                                  <span className={cn('text-center tabular-nums', sc(Math.min(r.faithfulness, r.relevance)))}>{Math.round(r.faithfulness * 100)}/{Math.round(r.relevance * 100)}</span>
                                  <span className={cn('text-right tabular-nums font-medium', sc(r.correctness))}>{Math.round(r.correctness * 100)}%</span>
                                </div>
                                {qualitySelectedQ === r.id && (
                                  <div className="mx-3 mb-2 p-3 bg-muted/50 rounded-lg border text-xs space-y-2">
                                    <div><div className="text-[10px] text-muted-foreground font-medium mb-0.5">Question</div><div>{r.question}</div></div>
                                    <div><div className="text-[10px] text-muted-foreground font-medium mb-0.5">Generated</div><div className="text-muted-foreground leading-relaxed">{r.generated}</div></div>
                                    <div><div className="text-[10px] text-muted-foreground font-medium mb-0.5">Expected</div><div className="leading-relaxed">{r.expected}</div></div>
                                    <div className="flex gap-3 pt-1">
                                      {[['Faith', r.faithfulness], ['Rel', r.relevance], ['Corr', r.correctness]].map(([k, v]) => (
                                        <span key={k} className={cn('text-[10px] font-semibold', sc(v))}>{k} {Math.round(v * 100)}%</span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                </>
              )}
            </div>
          </SheetContent>
        </Sheet>

        {/* ── File preview modal ── */}
        {previewFile && (() => {
          const ext      = previewFile.split('.').pop().toLowerCase()
          const isImage  = ['png','jpg','jpeg','gif','bmp','webp'].includes(ext)
          const isPdfLike = ['pdf','pptx','docx','doc','xlsx','xls'].includes(ext)
          const hasText  = previewText !== null
          return (
            <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => setPreviewFile(null)}>
              <div className="bg-background rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
                onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0">
                  <span className="text-sm font-medium truncate">{previewFile}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {previewBlobUrl && (
                      <Button variant="ghost" size="sm" className="gap-1.5 text-xs h-8"
                        onClick={() => window.open(previewBlobUrl, '_blank')}>
                        <ExternalLink className="w-3 h-3" /> Open in tab
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPreviewFile(null)}>
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-2 min-h-0">
                  {isPdfLike && (
                    previewBlobUrl
                      ? <iframe src={previewBlobUrl} title={previewFile} className="w-full h-full rounded-lg min-h-[500px]" />
                      : hasText ? <pre className="text-xs p-4 font-mono whitespace-pre-wrap">{previewText}</pre>
                        : <div className="flex items-center justify-center h-40 text-sm text-muted-foreground gap-2"><Loader2 className="w-4 h-4 animate-spin" />Converting to PDF…</div>
                  )}
                  {isImage && (
                    previewBlobUrl
                      ? <img src={previewBlobUrl} alt={previewFile} className="max-w-full max-h-full mx-auto object-contain rounded" />
                      : <div className="flex items-center justify-center h-40 text-sm text-muted-foreground gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
                  )}
                  {!isPdfLike && !isImage && hasText && (
                    <pre className="text-xs p-4 font-mono whitespace-pre-wrap leading-relaxed">{previewText}</pre>
                  )}
                  {!isPdfLike && !isImage && !hasText && (
                    <div className="flex items-center justify-center h-40 text-sm text-muted-foreground gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />Loading…
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    </TooltipProvider>
  )
}

// ─── Root App ────────────────────────────────────────────────────────────────

function App() {
  const [authToken, setAuthToken]   = useState(() => localStorage.getItem('rag_token'))
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rag_user')) } catch { return null }
  })

  const handleAuth    = (token, user) => { setAuthToken(token); setCurrentUser(user) }
  const handleLogout  = useCallback(() => {
    localStorage.removeItem('rag_token'); localStorage.removeItem('rag_user')
    setAuthToken(null); setCurrentUser(null)
  }, [])

  const authFetch = useCallback((url, options = {}) => {
    return fetch(url, {
      ...options,
      headers: { ...options.headers, ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) }
    }).then(res => { if (res.status === 401) handleLogout(); return res })
  }, [authToken, handleLogout])

  if (!authToken || !currentUser) return <AuthScreen onAuth={handleAuth} />
  return <MainApp authFetch={authFetch} currentUser={currentUser} onLogout={handleLogout} />
}

export default App
