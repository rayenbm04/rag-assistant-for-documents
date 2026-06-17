import { useState, useRef, useCallback, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import './App.css'

const API = import.meta.env.VITE_API_URL || "http://localhost:8000"

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

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function generateId() {
  return Math.random().toString(36).substring(2, 9)
}

function App() {
  const [question, setQuestion] = useState('')
  const [history, setHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('rag-chat-history')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const [files, setFiles] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [showDashboard, setShowDashboard] = useState(false)
  const [dashboardData, setDashboardData] = useState(null)
  const fileInputRef = useRef(null)
  const chatEndRef = useRef(null)
  const abortControllerRef = useRef(null)
  const scrollTimerRef = useRef(null)
  const pendingIdRef = useRef(null)
  const isLoadingRef = useRef(false)
  const currentQuestionRef = useRef('')
  const pollingRef = useRef({})
  const historyRef = useRef([])
  const historyIndexRef = useRef(-1)   // -1 = current draft
  const draftQuestionRef = useRef('')  // saves what user was typing before navigating

  // Keep historyRef in sync so handleSubmit always reads the latest history
  useEffect(() => { historyRef.current = history }, [history])

  const handleInputKeyDown = useCallback((e) => {
    if (isLoadingRef.current) return
    const completed = historyRef.current.filter(h => h.answer !== null)
    if (completed.length === 0) return

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (historyIndexRef.current === -1) {
        draftQuestionRef.current = e.target.value  // save current draft
      }
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

  // Persist chat history to localStorage on every change
  useEffect(() => {
    try {
      // Only persist completed entries (no pending null answers)
      const toSave = history.filter(e => e.answer !== null)
      localStorage.setItem('rag-chat-history', JSON.stringify(toSave))
    } catch {}
  }, [history])

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // load already-indexed documents on startup
  useEffect(() => {
    fetch(`${API}/documents`)
      .then(r => r.json())
      .then(docs => {
        setFiles(docs.map(d => ({
          id: d.id,
          name: d.name,
          size: 0,
          type: 'existing',
          status: d.status || 'ready'
        })))
      })
      .catch(() => {})
  }, [])

  // poll status for a file until it becomes ready or error
  const pollStatus = useCallback((filename) => {
    if (pollingRef.current[filename]) return

    pollingRef.current[filename] = setInterval(async () => {
      try {
        const res = await fetch(`${API}/status/${encodeURIComponent(filename)}`)
        const data = await res.json()

        if (data.status === 'ready' || data.status === 'error') {
          // stop polling
          clearInterval(pollingRef.current[filename])
          delete pollingRef.current[filename]

          // update file status in UI
          setFiles(prev => prev.map(f =>
            f.name === filename ? { ...f, status: data.status } : f
          ))
        }
      } catch (e) {
        clearInterval(pollingRef.current[filename])
        delete pollingRef.current[filename]
      }
    }, 2000) // poll every 2 seconds
  }, [])

  // cleanup polling on unmount
  useEffect(() => {
    return () => {
      Object.values(pollingRef.current).forEach(clearInterval)
    }
  }, [])

  const uploadToBackend = useCallback(async (file) => {
    const formData = new FormData()
    formData.append("file", file)
    const res = await fetch(`${API}/upload`, {
      method: "POST",
      body: formData
    })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    return await res.json()
  }, [])

  const handleFileSelect = useCallback(async (selectedFiles) => {
    const validFiles = Array.from(selectedFiles).filter(file => {
      const ext = file.name.split('.').pop().toLowerCase()
      return (
        file.type === 'application/pdf' ||
        file.type.startsWith('image/') ||
        file.type === 'text/plain' ||
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        ext === 'txt' ||
        ext === 'docx'
      )
    })

    for (const f of validFiles) {
      const tempId = generateId()

      // replace any existing entry with the same name, then add new one
      setFiles(prev => [...prev.filter(e => e.name !== f.name), {
        id: tempId,
        name: f.name,
        size: f.size,
        type: f.type,
        status: 'uploading'
      }])

      try {
        const result = await uploadToBackend(f)

        // update to "indexing" once uploaded
        setFiles(prev => prev.map(existing =>
          existing.id === tempId
            ? { ...existing, id: result.id, status: 'indexing' }
            : existing
        ))

        // start polling for ready status
        pollStatus(f.name)

      } catch (err) {
        setFiles(prev => prev.map(existing =>
          existing.id === tempId
            ? { ...existing, status: 'error' }
            : existing
        ))
      }
    }
  }, [uploadToBackend, pollStatus])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(false)
    handleFileSelect(e.dataTransfer.files)
  }, [handleFileSelect])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleRemoveFile = useCallback(async (id, filename) => {
    try {
      const res = await fetch(`${API}/documents/${encodeURIComponent(filename)}`, {
        method: "DELETE"
      })
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`)
      }
      setFiles(prev => prev.filter(f => f.id !== id))
    } catch (e) {
      console.error("Delete failed:", e)
      alert("Failed to delete the file from the server. It might be locked or busy.")
    }
  }, [])

const handleCancel = useCallback((e) => {
  if (e && e.preventDefault) e.preventDefault()
  console.log('[handleCancel] called, pendingIdRef:', pendingIdRef.current, 'isLoadingRef:', isLoadingRef.current)
  if (scrollTimerRef.current) {
    clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = null
  }
  const cancelledId = pendingIdRef.current
  pendingIdRef.current = null
  isLoadingRef.current = false
  if (cancelledId) {
    setHistory(prev => prev.filter(e => e.id !== cancelledId))
  }
  console.log('[handleCancel] calling setQuestion:', currentQuestionRef.current)
  setQuestion(currentQuestionRef.current)
  console.log('[handleCancel] calling setIsLoading(false)')
  setIsLoading(false)
  if (abortControllerRef.current) {
    abortControllerRef.current.abort()
    abortControllerRef.current = null
  }
  console.log('[handleCancel] done')
}, [])

const handleSubmit = useCallback(async (e) => {
  e.preventDefault()
  if (!question.trim() || isLoadingRef.current) return

  const currentQuestion = question.trim()
  currentQuestionRef.current = currentQuestion
  historyIndexRef.current = -1
  draftQuestionRef.current = ''
  isLoadingRef.current = true
  setIsLoading(true)
  setQuestion('')   // clear immediately — disables Send, prevents double-submit
  setError(null)

  abortControllerRef.current = new AbortController()

  const tempId = generateId()
  pendingIdRef.current = tempId

  setHistory(prev => [...prev, {
    id: tempId,
    question: currentQuestion,
    answer: null,
    sources: [],
    warning: null
  }])
  scrollTimerRef.current = setTimeout(scrollToBottom, 100)

  try {
    const res = await fetch(`${API}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: currentQuestion,
        history: historyRef.current
          .filter(e => e.answer !== null && !e.answer.startsWith('Error:'))
          .map(e => ({ question: e.question, answer: e.answer }))
      }),
      signal: abortControllerRef.current.signal
    })

    // If cancelled while waiting, stop here
    if (!pendingIdRef.current) return

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.detail || `Server error: ${res.status}`)
    }

    const response = await res.json()

    // If cancelled while reading body, stop here
    if (!pendingIdRef.current) return

    setHistory(prev => prev.map(entry =>
      entry.id === tempId
        ? { ...entry, answer: response.answer.trim(), sources: response.sources || [], warning: response.warning || null }
        : entry
    ))
    // question already cleared at submit time
    scrollTimerRef.current = setTimeout(scrollToBottom, 100)

  } catch (err) {
    // If already cancelled by handleCancel, do nothing (UI already cleaned up)
    if (!pendingIdRef.current) return
    // Real error — restore question so user can retry
    setQuestion(currentQuestionRef.current)
    setHistory(prev => prev.map(entry =>
      entry.id === tempId
        ? { ...entry, answer: `Error: ${err.message}` }
        : entry
    ))
  } finally {
    if (pendingIdRef.current === tempId) {
      pendingIdRef.current = null
      isLoadingRef.current = false
      setIsLoading(false)
      abortControllerRef.current = null
    }
  }
}, [question, scrollToBottom])
  const getStatusBadge = (status) => {
  switch (status) {
    case 'uploading':  return { label: 'Uploading...', color: 'var(--text-muted)' }
    case 'indexing':   return { label: 'Indexing...', color: '#854F0B' }
    case 'ready':      return { label: 'Ready', color: '#3B6D11' }
    case 'error':      return { label: 'Error', color: '#e53e3e' }
    case 'cancelled':  return { label: 'Cancelled', color: 'var(--text-muted)' }
    default:           return null
  }
}
const handleCancelIndexing = useCallback(async (filename) => {
  try {
    await fetch(`${API}/cancel/${encodeURIComponent(filename)}`, {
      method: "POST"
    })
    // stop polling
    if (pollingRef.current[filename]) {
      clearInterval(pollingRef.current[filename])
      delete pollingRef.current[filename]
    }
    setFiles(prev => prev.filter(f => f.name !== filename))
  } catch (e) {
    console.error("Cancel failed:", e)
  }
}, [])

  const openDashboard = useCallback(async () => {
    setShowDashboard(true)
    try {
      const res = await fetch(`${API}/dashboard`)
      const data = await res.json()
      setDashboardData(data)
    } catch {
      setDashboardData(null)
    }
  }, [])

  const anyIndexing = files.some(f => f.status === 'indexing' || f.status === 'uploading')

  return (
    <div className="app">
      <nav className="navbar">
        <div className="navbar-logo">RAG Assistant</div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '16px' }}>
          {anyIndexing && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Indexing documents...
            </span>
          )}
          <button className="clear-history-btn" onClick={openDashboard}>
            Stats
          </button>
          {history.filter(e => e.answer !== null).length > 0 && (
            <button className="clear-history-btn" onClick={() => window.print()}>
              Export PDF
            </button>
          )}
          {history.length > 0 && !isLoading && (
            <button
              className="clear-history-btn"
              onClick={() => {
                setHistory([])
                localStorage.removeItem('rag-chat-history')
              }}
            >
              Clear chat
            </button>
          )}
        </div>
      </nav>

      <div className="main-container">
        <aside className="sidebar">
          <h2 className="sidebar-title">Documents</h2>

          <div
            className={`upload-zone ${isDragOver ? 'dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <UploadIcon />
            <p className="upload-text">Click or drag to upload</p>
            <p className="upload-hint">PDF, Word, TXT or images</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.docx,image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleFileSelect(e.target.files); e.target.value = '' }}
            />
          </div>

          {files.length > 0 && (
            <div className="file-list">
              {files.map(file => {
                const badge = getStatusBadge(file.status)
                return (
                  <div
                    key={file.id}
                    className={`file-item ${file.status === 'ready' ? 'file-item--clickable' : ''}`}
                    onClick={() => {
                      if (file.status === 'ready') {
                        window.open(`${API}/files/${encodeURIComponent(file.name)}`, '_blank')
                      }
                    }}
                  >
                    <FileIcon />
                    <div className="file-info">
                      <div className="file-name">{file.name}</div>
                      <div className="file-size" style={{ color: badge?.color }}>
                        {badge ? badge.label : formatFileSize(file.size)}
                      </div>
                    </div>
                    {file.status === 'ready' && (
                     <div onClick={(e) => { e.stopPropagation(); handleRemoveFile(file.id, file.name) }} style={{ cursor: 'pointer' }}>
                      <RemoveIcon />
                      </div>
                    )}
                    {(file.status === 'indexing' || file.status === 'uploading') && (
  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
    <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
      {[0,1,2].map(i => (
        <div key={i} style={{
          width: '4px', height: '4px', borderRadius: '50%',
          background: 'var(--text-muted)',
          animation: `loading-pulse 1.2s infinite ${i * 0.2}s`
        }} />
      ))}
    </div>
    {file.status === 'indexing' && (
      <span
        onClick={() => handleCancelIndexing(file.name)}
        style={{
          fontSize: '11px', color: '#854F0B',
          cursor: 'pointer', textDecoration: 'underline'
        }}
      >
        cancel
      </span>
    )}
  </div>
)}
                  </div>
                )
              })}
            </div>
          )}
        </aside>

        <main className="chat-area">
          {/* Visible only when printing */}
          <div className="print-header">
            <div className="print-header-title">RAG Assistant — Chat Export</div>
            <div className="print-header-date">
              {new Date().toLocaleString()}
            </div>
          </div>
          <div className="chat-messages">
            {history.length === 0 && !isLoading && (
              <div className="chat-empty">
                <ChatIcon />
                <h3 className="chat-empty-title">Start a conversation</h3>
                <p className="chat-empty-text">
                  Upload documents and ask questions to get answers with source citations.
                </p>
              </div>
            )}

            {history.map(entry => (
              <div key={entry.id} className="conversation-entry">

                {/* user question */}
                <div className="message-wrapper user">
                  <div className="message user">
                    <p className="message-content">{entry.question}</p>
                  </div>
                </div>

                {/* AI answer */}
                <div className="message-wrapper ai">
                  <div className="message ai">
                    {entry.answer === null ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div className="loading-dots">
                          <div className="loading-dot" />
                          <div className="loading-dot" />
                          <div className="loading-dot" />
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

                  {/* warning — files still indexing */}
                  {entry.warning && (
                    <p style={{
                      fontSize: '12px', color: '#854F0B',
                      margin: '6px 0 0', padding: '6px 10px',
                      background: '#FAEEDA', borderRadius: '6px'
                    }}>
                      ⚠ {entry.warning}
                    </p>
                  )}

                  {/* sources */}
                  {entry.sources && entry.sources.length > 0 && entry.answer !== null && (
                    <div className="sources">
                      {entry.sources.map((source, idx) => (
                        <span key={idx} className="source-pill">
                          <SourceIcon />
                          {source}
                        </span>
                      ))}
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
                type="text"
                className="input-field"
                placeholder="Ask a question about your documents..."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={handleInputKeyDown}
                disabled={isLoading}
              />
    {isLoading ? (
      <button
        key="cancel-btn"
        type="button"
        className="cancel-button"
        onClick={handleCancel}
      >
        Cancel
      </button>
    ) : (
      <button
        key="send-btn"
        type="submit"
        className="send-button"
        disabled={!question.trim()}
      >
        Send
      </button>
    )}
  </div>
</form>
        </main>
      </div>

      {/* ── Dashboard modal ── */}
      {showDashboard && (
        <div className="dashboard-overlay" onClick={() => setShowDashboard(false)}>
          <div className="dashboard-modal" onClick={e => e.stopPropagation()}>
            <div className="dashboard-header">
              <h2 className="dashboard-title">Usage Stats</h2>
              <button className="dashboard-close" onClick={() => setShowDashboard(false)}>✕</button>
            </div>

            {!dashboardData ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading…</p>
            ) : (
              <>
                {/* Top stat cards */}
                <div className="dashboard-cards">
                  <div className="dashboard-card">
                    <div className="dashboard-card-value">{history.filter(e => e.answer !== null).length}</div>
                    <div className="dashboard-card-label">Questions asked</div>
                  </div>
                  <div className="dashboard-card">
                    <div className="dashboard-card-value">{dashboardData.documents.ready}</div>
                    <div className="dashboard-card-label">Documents ready</div>
                  </div>
                  <div className="dashboard-card">
                    <div className="dashboard-card-value">{dashboardData.chunks.total}</div>
                    <div className="dashboard-card-label">Total chunks</div>
                  </div>
                  <div className="dashboard-card">
                    <div className="dashboard-card-value">{dashboardData.config.similarity_top_k}</div>
                    <div className="dashboard-card-label">Chunks per query</div>
                  </div>
                </div>

                {/* Models */}
                <div className="dashboard-section">
                  <h3 className="dashboard-section-title">Active models</h3>
                  <div className="dashboard-model-list">
                    {[
                      { label: 'LLM', value: dashboardData.models.llm },
                      { label: 'Embeddings', value: dashboardData.models.embed },
                      { label: 'Vision', value: dashboardData.models.vision },
                    ].map(({ label, value }) => (
                      <div key={label} className="dashboard-model-row">
                        <span className="dashboard-model-label">{label}</span>
                        <code className="dashboard-model-value">{value}</code>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Token usage */}
                <div className="dashboard-section">
                  <h3 className="dashboard-section-title">Token usage (this session)</h3>
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

                {/* Cost comparison */}
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
                        const cost = (
                          (dashboardData.tokens.prompt     / 1_000_000) * input +
                          (dashboardData.tokens.completion / 1_000_000) * output
                        )
                        return (
                          <div key={model} className="dashboard-doc-row">
                            <span className="dashboard-doc-name">{model}</span>
                            <span className="dashboard-doc-chunks">
                              ${cost < 0.001 ? '<$0.001' : cost.toFixed(4)}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      Prices per 1M tokens (input / output). Resets on server restart.
                    </p>
                  </div>
                )}

                {/* Per-document chunks */}
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
